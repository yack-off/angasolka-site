import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database,Queryable} from './db.js';
import {AppError} from './contracts.js';
import {authorize,audit,object,str,version,type Actor} from './admin-auth.js';
import {localToday} from './pricing.js';

const uuid={type:'string',format:'uuid'};
const page={type:'string',pattern:'^[1-9][0-9]{0,5}$'};
const missing=()=>new AppError(404,'NOT_FOUND','Запись не найдена.');
const conflict=()=>new AppError(409,'VERSION_CONFLICT','Запись уже изменена. Обновите карточку и повторите действие.');
const duplicate=()=>new AppError(409,'IDEMPOTENCY_CONFLICT','Этот идентификатор уже использован для другого действия.');
async function lockOrder(tx:Queryable,id:string) {
  const row=(await tx.query('SELECT id,version,assignee_id FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row)throw missing();return row;
}
async function checkAssignee(tx:Queryable,id:string) {
  if(!(await tx.query("SELECT id FROM staff WHERE id=$1 AND active=true AND role IN ('owner','manager') FOR SHARE",[id])).rows.length)
    throw new AppError(400,'INVALID_ASSIGNEE','Выберите действующего владельца или менеджера.');
}
async function record(tx:Queryable,actor:Actor,orderId:string,event:string,details:Record<string,unknown>) {
  const eventId=randomUUID();
  await tx.query('INSERT INTO order_events(id,order_id,event_type,actor,payload) VALUES($1,$2,$3,$4,$5)',[eventId,orderId,event,actor.id,JSON.stringify(details)]);
  await tx.query('INSERT INTO outbox(id,event_id,topic,payload) VALUES($1,$2,$3,$4)',[randomUUID(),eventId,event,JSON.stringify({orderId,eventId,...details})]);
  await audit(tx,actor,event,orderId,details);
}
export async function assignOrder(db:Database,actor:Actor,id:string,input:{version:number;assigneeId:string|null}) {
  return db.transaction(async tx=>{
    await authorize(tx,actor,true);
    if(input.assigneeId)await checkAssignee(tx,input.assigneeId);
    const order=await lockOrder(tx,id);if(order.version!==input.version)throw conflict();
    await tx.query('UPDATE orders SET assignee_id=$1,version=version+1 WHERE id=$2',[input.assigneeId,id]);
    await record(tx,actor,id,'crm.assigned',{assigneeId:input.assigneeId,version:input.version+1});
    return {ok:true,version:input.version+1};
  });
}
type NoteInput={id:string;body:string};
export async function addNote(db:Database,actor:Actor,orderId:string,input:NoteInput) {
  return db.transaction(async tx=>{
    await authorize(tx,actor,true);await lockOrder(tx,orderId);
    const body=input.body.trim();if(!body)throw new AppError(400,'INVALID_TEXT','Введите текст заметки.');
    const inserted=await tx.query('INSERT INTO crm_notes(id,order_id,author_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id',[input.id,orderId,actor.id,body]);
    if(!inserted.rows.length){
      const prior=(await tx.query('SELECT order_id,author_id,body FROM crm_notes WHERE id=$1',[input.id])).rows[0];
      if(prior.order_id!==orderId||prior.author_id!==actor.id||prior.body!==body)throw duplicate();
      return {id:input.id,replayed:true};
    }
    await record(tx,actor,orderId,'crm.note_added',{noteId:input.id});return {id:input.id,replayed:false};
  });
}
type TaskInput={id:string;title:string;dueDate:string;assigneeId:string};
export async function addTask(db:Database,actor:Actor,orderId:string,input:TaskInput) {
  return db.transaction(async tx=>{
    await authorize(tx,actor,true);await checkAssignee(tx,input.assigneeId);await lockOrder(tx,orderId);
    const title=input.title.trim();if(!title)throw new AppError(400,'INVALID_TEXT','Введите название задачи.');
    const inserted=await tx.query('INSERT INTO crm_tasks(id,order_id,author_id,assignee_id,title,due_date) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id',[input.id,orderId,actor.id,input.assigneeId,title,input.dueDate]);
    if(!inserted.rows.length){
      const p=(await tx.query('SELECT order_id,author_id,assignee_id,title,due_date::text FROM crm_tasks WHERE id=$1',[input.id])).rows[0];
      if(p.order_id!==orderId||p.author_id!==actor.id||p.assignee_id!==input.assigneeId||p.title!==title||p.due_date!==input.dueDate)throw duplicate();
      return {id:input.id,replayed:true};
    }
    await record(tx,actor,orderId,'crm.task_added',{taskId:input.id});return {id:input.id,replayed:false};
  });
}
export async function setTaskStatus(db:Database,actor:Actor,id:string,input:{version:number;status:'open'|'done'}) {
  return db.transaction(async tx=>{
    await authorize(tx,actor,true);
    const task=(await tx.query('SELECT order_id,version FROM crm_tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!task)throw missing();if(task.version!==input.version)throw conflict();
    await tx.query("UPDATE crm_tasks SET status=$1,completed_at=CASE WHEN $1='done' THEN now() ELSE NULL END,version=version+1 WHERE id=$2",[input.status,id]);
    await record(tx,actor,task.order_id,'crm.task_updated',{taskId:id,status:input.status,version:input.version+1});
    return {ok:true,version:input.version+1};
  });
}

// Registered inside the protected admin scope. Writes also recheck role in the transaction.
export async function registerCrm(app:FastifyInstance,db:Database,current:(req:FastifyRequest)=>Promise<Actor>) {
  const schema=(summary:string,extra:Record<string,unknown>={})=>({tags:['CRM'],summary,security:[{staffSession:[]}],...extra});
  app.get('/crm/team',{schema:schema('Сотрудники для назначения: без паролей, доступно всем сотрудникам')},async()=>({items:(await db.query('SELECT id,username,role,active FROM staff ORDER BY username,id')).rows}));
  app.get<{Querystring:{page?:string;assignee?:string;attention?:string;status?:string}}>('/crm/orders',{schema:schema('Воронка заявок; 25 карточек на страницу, счётчики по всему фильтру. Просрочка — до текущей даты Asia/Irkutsk',{querystring:object({page,assignee:{enum:['all','mine','unassigned']},attention:{enum:['all','overdue','today','no_tasks']},status:{enum:['pending','contacted','cancelled']}},[])})},async req=>{
    const actor=await current(req),today=localToday();
    const params=[req.query.assignee??'all',actor.id,req.query.attention??'all',today,req.query.status??null];
    const where=` WHERE ($1='all' OR ($1='mine' AND o.assignee_id=$2::uuid) OR ($1='unassigned' AND o.assignee_id IS NULL))
      AND ($3='all' OR ($3='no_tasks' AND NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.order_id=o.id AND t.status='open'))
        OR EXISTS(SELECT 1 FROM crm_tasks t WHERE t.order_id=o.id AND t.status='open' AND (($3='overdue' AND t.due_date<$4::date) OR ($3='today' AND t.due_date=$4::date))))
      AND ($5::text IS NULL OR o.status=$5)`;
    const counts=(await db.query('SELECT o.status,count(*)::integer AS count FROM orders o'+where+' GROUP BY o.status',params)).rows;
    const items=(await db.query(`SELECT o.id,o.status,o.arrival::text,o.departure::text,o.beds,o.total_minor,o.version,o.assignee_id,c.name,s.username AS assignee_name,
      (SELECT min(t.due_date)::text FROM crm_tasks t WHERE t.order_id=o.id AND t.status='open') AS next_due,
      (SELECT count(*)::integer FROM crm_tasks t WHERE t.order_id=o.id AND t.status='open') AS open_tasks
      FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN staff s ON s.id=o.assignee_id`+where+` ORDER BY o.created_at DESC,o.id LIMIT 25 OFFSET $6`,[...params,(Number(req.query.page??1)-1)*25])).rows;
    return {items,counts,total:counts.reduce((s,c)=>s+c.count,0),today,timezone:'Asia/Irkutsk'};
  });
  app.get<{Params:{id:string};Querystring:{notesPage?:string;tasksPage?:string}}>('/crm/orders/:id',{schema:schema('Заметки и задачи заявки; независимые страницы по 25, открытые задачи первыми',{params:object({id:uuid}),querystring:object({notesPage:page,tasksPage:page},[])})},async req=>{
    if(!(await db.query('SELECT id FROM orders WHERE id=$1',[req.params.id])).rows.length)throw missing();
    const notes=(await db.query('SELECT n.id,n.body,n.created_at,s.username FROM crm_notes n JOIN staff s ON s.id=n.author_id WHERE n.order_id=$1 ORDER BY n.created_at DESC,n.id LIMIT 25 OFFSET $2',[req.params.id,(Number(req.query.notesPage??1)-1)*25])).rows;
    const tasks=(await db.query("SELECT t.id,t.title,t.due_date::text,t.status,t.version,t.assignee_id,t.completed_at,s.username FROM crm_tasks t JOIN staff s ON s.id=t.assignee_id WHERE t.order_id=$1 ORDER BY (t.status='open') DESC,t.due_date,t.id LIMIT 25 OFFSET $2",[req.params.id,(Number(req.query.tasksPage??1)-1)*25])).rows;
    const totals=(await db.query('SELECT (SELECT count(*)::integer FROM crm_notes WHERE order_id=$1) AS notes,(SELECT count(*)::integer FROM crm_tasks WHERE order_id=$1) AS tasks',[req.params.id])).rows[0];
    return {notes,tasks,totals,today:localToday()};
  });
  app.patch<{Params:{id:string};Body:{version:number;assigneeId:string|null}}>('/crm/orders/:id/assignee',{schema:schema('Назначить ответственного; общая версия с заявкой',{params:object({id:uuid}),body:object({version,assigneeId:{anyOf:[uuid,{type:'null'}]}})})},async req=>assignOrder(db,await current(req),req.params.id,req.body));
  app.post<{Params:{id:string};Body:NoteInput}>('/crm/orders/:id/notes',{schema:schema('Добавить внутреннюю заметку; UUID id повторяют при повторной отправке того же тела',{params:object({id:uuid}),body:object({id:uuid,body:str(2000)})})},async req=>addNote(db,await current(req),req.params.id,req.body));
  app.post<{Params:{id:string};Body:TaskInput}>('/crm/orders/:id/tasks',{schema:schema('Создать задачу; UUID id обеспечивает идемпотентность, dueDate — день в Asia/Irkutsk',{params:object({id:uuid}),body:object({id:uuid,title:str(200),dueDate:{type:'string',format:'date',pattern:'^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$'},assigneeId:uuid})})},async req=>addTask(db,await current(req),req.params.id,req.body));
  app.patch<{Params:{id:string};Body:{version:number;status:'open'|'done'}}>('/crm/tasks/:id',{schema:schema('Завершить или возобновить задачу с проверкой версии',{params:object({id:uuid}),body:object({version,status:{enum:['open','done']}})})},async req=>setTaskStatus(db,await current(req),req.params.id,req.body));
}
