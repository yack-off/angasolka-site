import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {connectDatabase,migrate,type Database} from '../src/db.js';
import {addNote} from '../src/crm.js';
import {localToday} from '../src/pricing.js';
import type {Actor} from '../src/admin-auth.js';
let db:Database,app:Awaited<ReturnType<typeof buildApp>>,cookie:string,managerCookie:string,viewerCookie:string,managerId:string,viewerId:string,actor:Actor;
const origin='http://127.0.0.1:4180';
const call=(method:'GET'|'POST'|'PATCH',path:string,payload?:unknown,auth=cookie)=>app.inject({method,url:'/api/v1/admin'+path,headers:{origin,cookie:auth??''},...(payload?{payload}:{})});
before(async()=>{
  db=await connectDatabase(undefined,'memory://');await migrate(db);await migrate(db);app=await buildApp(db,{localSetup:true,rateMax:10000});await app.ready();
  const password=randomBytes(24).toString('hex');const setup=await call('POST','/setup',{username:'crm-owner',password},'');
  assert.equal(setup.statusCode,200,setup.body);cookie=String(setup.headers['set-cookie']).split(';')[0];actor=setup.json().user;
  for(const role of ['manager','viewer']){
    const created=await call('POST','/staff',{username:'crm-'+role,password,role});assert.equal(created.statusCode,200,created.body);
    const login=await call('POST','/login',{username:'crm-'+role,password},'');const session=String(login.headers['set-cookie']).split(';')[0];
    if(role==='manager'){managerId=created.json().id;managerCookie=session;}else{viewerId=created.json().id;viewerCookie=session;}
  }
});
after(async()=>{await app.close();await db.close();});
async function order(){
  const trip={arrival:new Date(Date.now()+10*86400000).toISOString().slice(0,10),departure:new Date(Date.now()+12*86400000).toISOString().slice(0,10),beds:1,extras:{}};
  const q=(await app.inject({method:'POST',url:'/api/v1/quotes',payload:trip})).json();
  const token=randomBytes(32).toString('hex');
  const created=await app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':randomUUID()},payload:{...trip,customer:{name:'Проверка CRM',phone:'+'+'0'.repeat(11)},comment:'',consent:true,expectedTotalMinor:q.totalMinor,pricingVersion:q.pricingVersion,trackingToken:token}});
  assert.equal(created.statusCode,201,created.body);return {id:created.json().order.id as string,token,total:q.totalMinor};
}
test('CRM requires staff session and Origin, viewer cannot write, manager can assign without owner privileges',async()=>{
  const o=await order();
  for(const path of ['/crm/team','/crm/orders','/crm/orders/'+o.id])assert.equal((await call('GET',path,undefined,'')).statusCode,401);
  assert.equal((await call('GET','/crm/orders',undefined,viewerCookie)).statusCode,200);
  assert.equal((await call('GET','/crm/team',undefined,managerCookie)).statusCode,200);
  const assignment={version:1,assigneeId:managerId};
  assert.equal((await call('PATCH','/crm/orders/'+o.id+'/assignee',assignment,viewerCookie)).statusCode,403);
  assert.equal((await app.inject({method:'PATCH',url:'/api/v1/admin/crm/orders/'+o.id+'/assignee',headers:{cookie},payload:assignment})).statusCode,403);
  assert.equal((await call('PATCH','/crm/orders/'+o.id+'/assignee',{...assignment,assigneeId:viewerId})).statusCode,400);
  assert.equal((await call('PATCH','/crm/orders/'+o.id+'/assignee',assignment,managerCookie)).statusCode,200);
  assert.equal((await call('PATCH','/orders/'+o.id,{version:1,status:'contacted',comment:''})).statusCode,409);
  assert.ok((await call('GET','/crm/orders?assignee=mine',undefined,managerCookie)).json().items.some((x:any)=>x.id===o.id));
  assert.ok(!(await call('GET','/crm/orders?assignee=unassigned')).json().items.some((x:any)=>x.id===o.id));
  const detail=(await call('GET','/orders/'+o.id)).json().order;assert.equal(detail.total_minor,o.total);assert.equal(detail.version,2);
});
test('notes and tasks replay once; changed bodies conflict; private text stays out of events and public status',async()=>{
  const o=await order(),path='/crm/orders/'+o.id;
  const note={id:randomUUID(),body:'Заметка '+randomUUID()};
  const task={id:randomUUID(),title:'Уточнить маршрут '+randomUUID(),dueDate:localToday(),assigneeId:managerId};
  for(const [suffix,payload] of [['notes',note],['tasks',task]] as const){
    assert.equal((await call('POST',path+'/'+suffix,payload,viewerCookie)).statusCode,403);
    const first=await call('POST',path+'/'+suffix,payload,managerCookie);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().replayed,false);
    assert.equal((await call('POST',path+'/'+suffix,payload,managerCookie)).json().replayed,true);
  }
  assert.equal((await call('POST',path+'/notes',{...note,body:'Изменённая заметка'},managerCookie)).statusCode,409);
  assert.equal((await call('POST',path+'/tasks',{...task,title:'Иная задача'},managerCookie)).statusCode,409);
  const activity=(await call('GET',path)).json();assert.equal(activity.totals.notes,1);assert.equal(activity.totals.tasks,1);
  const internal=JSON.stringify((await db.query('SELECT payload FROM order_events WHERE order_id=$1 UNION ALL SELECT payload FROM outbox WHERE payload->>\'orderId\'=$2',[o.id,o.id])).rows);
  assert.ok(!internal.includes(note.body));assert.ok(!internal.includes(task.title));
  const audits=JSON.stringify((await db.query('SELECT details FROM admin_audit WHERE entity_id=$1',[o.id])).rows);assert.ok(!audits.includes(note.body));assert.ok(!audits.includes(task.title));
  const publicStatus=await app.inject({url:'/api/v1/orders/status',headers:{authorization:'Bearer '+o.token}});
  assert.equal(publicStatus.statusCode,200);assert.ok(!publicStatus.body.includes(note.body));assert.ok(!publicStatus.body.includes('assignee'));
  const events=(await db.query("SELECT count(*)::int AS n FROM outbox WHERE payload->>'orderId'=$1 AND topic LIKE 'crm.%'",[o.id])).rows[0].n;assert.equal(events,2);
});
test('task due filters use Irkutsk calendar, completion removes overdue and stale task versions conflict',async()=>{
  assert.equal(localToday(new Date('2026-09-14T16:01:00Z')),'2026-09-15');
  const o=await order(),today=localToday(),yesterday=new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
  const task={id:randomUUID(),title:'Перезвонить',dueDate:yesterday,assigneeId:managerId};
  assert.equal((await call('POST','/crm/orders/'+o.id+'/tasks',task)).statusCode,200);
  assert.ok((await call('GET','/crm/orders?attention=overdue')).json().items.some((x:any)=>x.id===o.id));
  assert.ok(!(await call('GET','/crm/orders?attention=today')).json().items.some((x:any)=>x.id===o.id));
  assert.equal((await call('PATCH','/crm/tasks/'+task.id,{version:1,status:'done'},viewerCookie)).statusCode,403);
  assert.equal((await call('PATCH','/crm/tasks/'+task.id,{version:1,status:'done'},managerCookie)).statusCode,200);
  assert.equal((await call('PATCH','/crm/tasks/'+task.id,{version:1,status:'open'})).statusCode,409);
  assert.ok(!(await call('GET','/crm/orders?attention=overdue')).json().items.some((x:any)=>x.id===o.id));
  assert.ok((await call('GET','/crm/orders?attention=no_tasks')).json().items.some((x:any)=>x.id===o.id));
  assert.equal((await call('PATCH','/crm/tasks/'+task.id,{version:2,status:'open'})).statusCode,200);
  assert.equal((await call('GET','/crm/orders/'+o.id)).json().tasks[0].completed_at,null);
  assert.equal((await call('PATCH','/orders/'+o.id,{version:1,status:'cancelled',comment:''})).statusCode,200);
  assert.ok((await call('GET','/crm/orders?status=cancelled&attention=overdue')).json().items.some((x:any)=>x.id===o.id));
});
test('invalid inputs cannot add data or fake public CRM fields; missing entities have 404',async()=>{
  const o=await order(),base={id:randomUUID(),title:'Задача',assigneeId:managerId,dueDate:localToday()};
  for(const body of [{...base,title:'   '},{...base,dueDate:'2026-02-30'},{...base,assigneeId:viewerId},{...base,status:'done'},{...base,assigneeId:randomUUID()}])assert.equal((await call('POST','/crm/orders/'+o.id+'/tasks',body)).statusCode,400);
  assert.equal((await call('POST','/crm/orders/'+o.id+'/notes',{id:randomUUID(),body:'  '})).statusCode,400);
  assert.equal((await call('GET','/crm/orders?page=0')).statusCode,400);
  assert.equal((await call('GET','/crm/orders?assignee='+managerId)).statusCode,400);
  assert.equal((await call('GET','/crm/orders/'+randomUUID())).statusCode,404);
  assert.equal((await call('PATCH','/crm/tasks/'+randomUUID(),{version:1,status:'done'})).statusCode,404);
  assert.equal((await call('POST','/crm/orders/'+randomUUID()+'/notes',{id:randomUUID(),body:'Текст'})).statusCode,404);
  const spec=(await app.inject({url:'/api/v1/openapi.json'})).json();
  assert.ok(spec.paths['/api/v1/admin/crm/orders/{id}/tasks'].post.requestBody);
  assert.deepEqual(spec.paths['/api/v1/admin/crm/orders'].get.security,[{staffSession:[]}]);
});
test('outbox failure rolls back note, order event and audit together',async()=>{
  const o=await order(),id=randomUUID();
  const failing:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{if(sql.startsWith('INSERT INTO outbox'))throw new Error('injected failure');return tx.query(sql,params);}}))};
  const count=async()=> (await db.query('SELECT count(*)::int AS n FROM order_events WHERE order_id=$1',[o.id])).rows[0].n;
  const before=await count();await assert.rejects(addNote(failing,actor,o.id,{id,body:'Не должна сохраниться'}),/injected failure/);
  assert.equal((await db.query('SELECT id FROM crm_notes WHERE id=$1',[id])).rows.length,0);assert.equal(await count(),before);
  assert.equal((await db.query("SELECT id FROM admin_audit WHERE entity_id=$1 AND action='crm.note_added'",[o.id])).rows.length,0);
});
test('notes paginate without losing history and disabled employees cannot be assigned',async()=>{
  const o=await order();
  for(let i=0;i<26;i++)await addNote(db,actor,o.id,{id:randomUUID(),body:'История '+i});
  const first=(await call('GET','/crm/orders/'+o.id)).json(),second=(await call('GET','/crm/orders/'+o.id+'?notesPage=2')).json();
  assert.equal(first.totals.notes,26);assert.equal(first.notes.length,25);assert.equal(second.notes.length,1);assert.ok(!first.notes.some((n:any)=>n.id===second.notes[0].id));
  await db.query('UPDATE staff SET active=false WHERE id=$1',[managerId]);
  assert.equal((await call('PATCH','/crm/orders/'+o.id+'/assignee',{version:1,assigneeId:managerId})).statusCode,400);
  assert.equal((await call('GET','/crm/orders',undefined,managerCookie)).statusCode,401);
});
