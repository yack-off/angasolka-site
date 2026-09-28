import {updateOrder} from './order-management.js';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import sharp from 'sharp';
import type {Database,Queryable} from './db.js';
import {AppError} from './contracts.js';
import {registerAuth,authorize,audit,object,str,int,version,passwordHash,verifyPassword,credentials,type Actor} from './admin-auth.js';
import {localToday} from './pricing.js';
import {registerCrm} from './crm.js';

type Field={key:string;type:'text'|'image';label:string;value:string;alt?:string};
const id={type:'string',pattern:'^[a-z][a-z0-9_-]{0,39}$'};
const uuid={type:'string',format:'uuid'};
const conflict=()=>new AppError(409,'VERSION_CONFLICT','Запись уже изменена. Обновите раздел и повторите правку.');
const missing=()=>new AppError(404,'NOT_FOUND','Запись не найдена.');
const pageSchema=object({page:{type:'string',pattern:'^[1-9][0-9]{0,5}$'}},[]);
const productSchema=object({id,title:str(120),unit:str(80),price_minor:int(10000000,1),active:{type:'boolean'},description:str(2000,0),category:{enum:['adventure','comfort']},image_url:str(150,0),sort_order:int(10000),version});
const fieldSchema=object({key:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,39}$'},type:{enum:['text','image']},label:str(100),value:str(4000,0),alt:str(300,0)},['key','type','label','value']);
const contentSchema=object({title:str(120),enabled:{type:'boolean'},sort_order:int(10000),fields:{type:'array',minItems:1,maxItems:100,items:fieldSchema},version});
export async function metric(db:Queryable,event:'page_view'|'quote') {
  await db.query('INSERT INTO metric_daily(day,event,count) VALUES($1,$2,1) ON CONFLICT(day,event) DO UPDATE SET count=metric_daily.count+1',[localToday(),event]);
}
export async function registerAdmin(app:FastifyInstance,db:Database,options:{origin:string;sessionKey:Buffer;localSetup:boolean}) {
  const current=await registerAuth(app,db,options);
  const assets=(await readdir(new URL('../public/assets',import.meta.url))).filter(n=>/\.(jpg|jpeg|png|webp|svg)$/.test(n));
  const checkImage=async(tx:Queryable,url:string)=>{
    if(!url)return;
    if(assets.some(a=>url==='/assets/'+a))return;
    const match=/^\/media\/([a-f0-9-]{36})$/.exec(url);
    if(match&&(await tx.query('SELECT id FROM media WHERE id=$1',[match[1]])).rows.length)return;
    throw new AppError(400,'INVALID_IMAGE','Выберите изображение из медиатеки.');
  };
  app.get('/api/v1/content',{schema:{tags:['Content'],summary:'Опубликованный контент публичного сайта'}},async()=>({blocks:(await db.query('SELECT id,title,enabled,sort_order,fields,custom FROM content_blocks ORDER BY sort_order,id')).rows}));
  app.get<{Params:{id:string}}>('/media/:id',{schema:{params:object({id:uuid}),summary:'Обработанное изображение WebP'}},async(req,reply)=>{
    const image=(await db.query('SELECT bytes,mime FROM media WHERE id=$1',[req.params.id])).rows[0];
    if(!image)throw missing();return reply.header('Cache-Control','public, max-age=31536000, immutable').type(image.mime).send(Buffer.from(image.bytes));
  });
  // Every protected route is inside this hook scope, including future additions.
  await app.register(async admin=>{
    admin.addHook('onRequest',async req=>{await current(req);});
    await registerCrm(admin,db,current);
    const schema=(summary:string,extra:Record<string,unknown>={})=>({tags:['Admin'],summary,security:[{staffSession:[]}],...extra});
    const edit=async<T>(actor:Actor,owner:boolean,fn:(tx:Queryable)=>Promise<T>)=>db.transaction(async tx=>{await authorize(tx,actor,true,owner);return fn(tx);});
    admin.get('/catalog',{schema:schema('Все услуги и версия тарифной политики')},async()=>({products:(await db.query('SELECT * FROM catalog ORDER BY sort_order,id')).rows,policy:(await db.query('SELECT * FROM pricing_policy WHERE id=1')).rows[0]}));
    admin.put<{Body:{id:string;title:string;unit:string;price_minor:number;active:boolean;description:string;category:string;image_url:string;sort_order:number;version:number}}>('/catalog',{schema:schema('Создать или изменить услугу, увеличив версию всей политики',{body:productSchema})},async req=>edit(await current(req),true,async tx=>{
      const b=req.body;
      const policy=(await tx.query('SELECT version FROM pricing_policy WHERE id=1 FOR UPDATE')).rows[0];
      if(policy.version!==b.version)throw conflict();
      if(b.id==='bed'&&!b.active)throw new AppError(400,'STAY_REQUIRED','Проживание — основа формы. Его нельзя отключить.');
      if(!b.title.trim()||!b.unit.trim())throw new AppError(400,'INVALID_TEXT','Название и единица обязательны.');
      await checkImage(tx,b.image_url);
      if(!(await tx.query('SELECT id FROM catalog WHERE id=$1',[b.id])).rows.length&&(await tx.query('SELECT count(*)::integer AS n FROM catalog')).rows[0].n>=31)throw new AppError(400,'CATALOG_LIMIT','Доступно не более 30 дополнительных услуг.');
      await tx.query('INSERT INTO catalog(id,title,unit,price_minor,active,description,category,image_url,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET title=$2,unit=$3,price_minor=$4,active=$5,description=$6,category=$7,image_url=$8,sort_order=$9',[b.id,b.title.trim(),b.unit.trim(),b.price_minor,b.active,b.description,b.category,b.image_url,b.sort_order]);
      await tx.query('UPDATE pricing_policy SET version=version+1 WHERE id=1');
      await audit(tx,await current(req),'catalog.save',b.id,{priceMinor:b.price_minor,active:b.active,version:b.version+1});
      return {ok:true,version:b.version+1};
    }));
    admin.put<{Body:{version:number;demo:boolean;discount_nights:number;discount_percent:number}}>('/policy',{schema:schema('Изменить скидку и признак демонстрационных тарифов',{body:object({version,demo:{type:'boolean'},discount_nights:int(365,1),discount_percent:int(99)})})},async req=>edit(await current(req),true,async tx=>{
      const b=req.body;const p=(await tx.query('SELECT version FROM pricing_policy WHERE id=1 FOR UPDATE')).rows[0];if(p.version!==b.version)throw conflict();
      await tx.query('UPDATE pricing_policy SET version=version+1,demo=$1,discount_nights=$2,discount_percent=$3 WHERE id=1',[b.demo,b.discount_nights,b.discount_percent]);
      await audit(tx,await current(req),'policy.save','1',{...b,version:b.version+1});return {ok:true};
    }));
    admin.get('/content',{schema:schema('Разделы сайта, поля, видимость и порядок')},async()=>({blocks:(await db.query('SELECT * FROM content_blocks ORDER BY sort_order,id')).rows}));
    admin.post<{Body:{title:string}}>('/content',{schema:schema('Добавить текстовый блок с фотографией',{body:object({title:str(120)})})},async req=>edit(await current(req),false,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(418003)');
      if((await tx.query('SELECT count(*)::integer AS n FROM content_blocks')).rows[0].n>=40)throw new AppError(400,'CONTENT_LIMIT','Доступно не более 40 блоков.');
      const key='custom-'+randomUUID().slice(0,8);
      const fields:Field[]=[{key:'heading',type:'text',label:'Заголовок',value:req.body.title},{key:'body',type:'text',label:'Текст',value:''},{key:'photo',type:'image',label:'Фотография',value:'',alt:''}];
      await tx.query('INSERT INTO content_blocks(id,title,sort_order,fields,custom,enabled) VALUES($1,$2,55,$3,true,false)',[key,req.body.title,JSON.stringify(fields)]);
      await audit(tx,await current(req),'content.create',key);return {id:key};
    }));
    admin.put<{Params:{id:string};Body:{title:string;enabled:boolean;sort_order:number;fields:Field[];version:number}}>('/content/:id',{bodyLimit:512*1024,schema:schema('Сохранить блок; состав ключей и типы полей неизменны',{params:object({id}),body:contentSchema})},async req=>edit(await current(req),false,async tx=>{
      const b=req.body;const prior=(await tx.query('SELECT * FROM content_blocks WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!prior)throw missing();if(prior.version!==b.version)throw conflict();
      if(req.params.id==='hero'&&!b.enabled)throw new AppError(400,'BOOKING_REQUIRED','Первый экран с формой должен оставаться видимым.');
      const old=prior.fields as Field[];
      if(b.fields.length!==old.length||new Set(b.fields.map(f=>f.key)).size!==old.length||b.fields.some(f=>!old.some(p=>p.key===f.key&&p.type===f.type)))throw new AppError(400,'INVALID_FIELDS','Состав полей блока изменён. Перезагрузите редактор.');
      for(const f of b.fields)if(f.type==='image')await checkImage(tx,f.value);
      await tx.query('UPDATE content_blocks SET title=$1,enabled=$2,sort_order=$3,fields=$4,version=version+1,updated_at=now() WHERE id=$5',[b.title,b.enabled,b.sort_order,JSON.stringify(b.fields),req.params.id]);
      await audit(tx,await current(req),'content.save',req.params.id,{version:b.version+1,enabled:b.enabled});return {ok:true};
    }));
    admin.get<{Querystring:{page?:string}}>('/media',{schema:schema('Медиатека; 24 загруженных изображения на страницу',{querystring:pageSchema})},async req=>({assets:assets.map(name=>({title:name,url:'/assets/'+name,alt:''})),items:(await db.query("SELECT id,title,alt,width,height,size,created_at,'/media/'||id AS url FROM media ORDER BY created_at DESC,id LIMIT 24 OFFSET $1",[(Number(req.query.page??1)-1)*24])).rows,total:(await db.query('SELECT count(*)::integer AS n FROM media')).rows[0].n}));
    admin.post<{Body:{title:string;alt:string;data:string}}>('/media',{bodyLimit:7*1024*1024,config:{rateLimit:{max:15,timeWindow:'1 minute'}},schema:schema('Загрузить JPEG/PNG/WebP, перекодирование WebP без метаданных; максимум 5 МБ',{body:object({title:str(120),alt:str(300,0),data:{type:'string',minLength:4,maxLength:7000000,pattern:'^[A-Za-z0-9+/]+={0,2}$'}})})},async req=>{
      const actor=await current(req);await authorize(db,actor,true);
      const input=Buffer.from(req.body.data,'base64');if(input.length>5*1024*1024)throw new AppError(413,'IMAGE_TOO_LARGE','Максимум 5 МБ.');
      let result;
      try {
        const source=sharp(input,{limitInputPixels:25000000});const meta=await source.metadata();
        if(!['jpeg','png','webp'].includes(meta.format??'')||(meta.pages??1)>1)throw new Error('format');
        result=await source.rotate().resize(2400,2400,{fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer({resolveWithObject:true});
      }catch{throw new AppError(400,'INVALID_IMAGE','Нужен корректный JPEG, PNG или WebP до 25 мегапикселей.');}
      const output=result;
      return edit(actor,false,async tx=>{
        const key=randomUUID();await tx.query('INSERT INTO media(id,title,alt,mime,bytes,size,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[key,req.body.title,req.body.alt,'image/webp',output.data,output.data.length,output.info.width,output.info.height]);
        await audit(tx,actor,'media.upload',key);return {id:key,url:'/media/'+key};
      });
    });
    admin.get<{Querystring:{page?:string;status?:string}}>('/orders',{schema:schema('Заявки и контакты; 25 на страницу',{querystring:object({page:{type:'string',pattern:'^[1-9][0-9]{0,5}$'},status:{enum:['pending','contacted','cancelled']}},[])})},async req=>{
      const params=[req.query.status??null];const where=' WHERE ($1::text IS NULL OR o.status=$1)';
      return {items:(await db.query('SELECT o.id,o.status,o.arrival::text,o.departure::text,o.beds,o.total_minor,o.created_at,o.version,c.name FROM orders o JOIN customers c ON c.id=o.customer_id'+where+' ORDER BY o.created_at DESC,o.id LIMIT 25 OFFSET $2',[...params,(Number(req.query.page??1)-1)*25])).rows,total:(await db.query('SELECT count(*)::integer AS n FROM orders o'+where,params)).rows[0].n};
    });
    admin.get<{Params:{id:string}}>('/orders/:id',{schema:schema('Карточка заявки, снимок расчёта и история без секретного кода',{params:object({id:uuid})})},async req=>{
      const order=(await db.query('SELECT o.id,o.status,o.arrival::text,o.departure::text,o.beds,o.comment,o.total_minor,o.quote,o.version,o.created_at,o.source,o.assignee_id,c.id AS customer_id,c.name,c.phone,c.version AS customer_version FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1',[req.params.id])).rows[0];
      if(!order)throw missing();return {order,events:(await db.query('SELECT event_type,actor,payload,created_at FROM order_events WHERE order_id=$1 ORDER BY created_at,id',[req.params.id])).rows};
    });
    admin.patch<{Params:{id:string};Body:{version:number;status:string;comment:string}}>('/orders/:id',{schema:schema('Изменить статус и комментарий; cancelled — конечный статус',{params:object({id:uuid}),body:object({version,status:{enum:['pending','contacted','cancelled']},comment:str(1000,0)})})},async req=>edit(await current(req),false,async tx=>{
      return updateOrder(tx,await current(req),req.params.id,req.body);
    }));
    admin.patch<{Params:{id:string};Body:{version:number;name:string;phone:string}}>('/customers/:id',{schema:schema('Исправить контакт клиента без объединения клиентов',{params:object({id:uuid}),body:object({version,name:str(80),phone:{...str(30,10),pattern:'^\\+?[0-9 ()-]+$'}})})},async req=>edit(await current(req),false,async tx=>{
      const b=req.body,phone=b.phone.replace(/[\s()-]/g,'');if(!b.name.trim()||!/^\+?\d{10,15}$/.test(phone))throw new AppError(400,'INVALID_CONTACT','Проверьте имя и телефон.');
      const rows=(await tx.query('UPDATE customers SET name=$1,phone=$2,version=version+1 WHERE id=$3 AND version=$4 RETURNING id',[b.name.trim(),phone,req.params.id,b.version])).rows;if(!rows.length)throw conflict();
      await audit(tx,await current(req),'customer.update',req.params.id,{fields:['name','phone'],version:b.version+1});return {ok:true};
    }));
    admin.get<{Querystring:{from?:string;to?:string}}>('/metrics',{schema:schema('Показатели за период до 366 дней, Asia/Irkutsk; суммы заявок не являются выручкой',{querystring:object({from:{type:'string',format:'date'},to:{type:'string',format:'date'}},[])})},async req=>{
      const to=req.query.to??localToday(),from=req.query.from??localToday(new Date(Date.now()-29*86400000));
      const days=(Date.parse(to)-Date.parse(from))/86400000;if(!Number.isFinite(days)||days<0||days>365)throw new AppError(400,'INVALID_PERIOD','Период — от 1 до 366 дней.');
      const params=[from,to];
      const summary=(await db.query("SELECT count(*)::integer AS orders,COALESCE(sum(total_minor),0)::text AS amount,COALESCE(round(avg(total_minor)),0)::text AS average,count(*) FILTER(WHERE status='pending')::integer AS pending,count(*) FILTER(WHERE status='contacted')::integer AS contacted,count(*) FILTER(WHERE status='cancelled')::integer AS cancelled FROM orders WHERE (created_at AT TIME ZONE 'Asia/Irkutsk')::date BETWEEN $1::date AND $2::date",params)).rows[0];
      const daily=(await db.query("SELECT (created_at AT TIME ZONE 'Asia/Irkutsk')::date::text AS day,count(*)::integer AS orders,COALESCE(sum(total_minor),0)::text AS amount FROM orders WHERE (created_at AT TIME ZONE 'Asia/Irkutsk')::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1",params)).rows;
      const traffic=(await db.query('SELECT day::text,event,count::text FROM metric_daily WHERE day BETWEEN $1::date AND $2::date ORDER BY day',params)).rows;
      const services=(await db.query("SELECT i.product_id,max(i.title) AS title,sum(i.quantity)::text AS quantity,sum(i.total_minor)::text AS amount FROM order_items i JOIN orders o ON o.id=i.order_id WHERE (o.created_at AT TIME ZONE 'Asia/Irkutsk')::date BETWEEN $1::date AND $2::date AND o.status<>'cancelled' GROUP BY i.product_id ORDER BY sum(i.total_minor) DESC",params)).rows;
      return {from,to,summary,daily,traffic,services,timezone:'Asia/Irkutsk'};
    });
    admin.get<{Querystring:{page?:string}}>('/audit',{schema:schema('История действий, без текстов контактов и паролей',{querystring:pageSchema})},async req=>({items:(await db.query('SELECT a.id,a.action,a.entity_id,a.details,a.created_at,u.username FROM admin_audit a JOIN staff u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id LIMIT 25 OFFSET $1',[(Number(req.query.page??1)-1)*25])).rows,total:(await db.query('SELECT count(*)::integer AS n FROM admin_audit')).rows[0].n}));
    admin.get('/staff',{schema:schema('Сотрудники; только владелец')},async req=>{await authorize(db,await current(req),false,true);return {items:(await db.query('SELECT id,username,role,active,version,created_at FROM staff ORDER BY created_at,id')).rows};});
    admin.post<{Body:{username:string;password:string;role:string}}>('/staff',{schema:schema('Создать сотрудника; только владелец',{body:object({...credentials.properties,role:{enum:['owner','manager','viewer']}})})},async req=>{
      const actor=await current(req);await authorize(db,actor,true,true);const encoded=await passwordHash(req.body.password);
      return edit(actor,true,async tx=>{
        const key=randomUUID();const rows=(await tx.query('INSERT INTO staff(id,username,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING RETURNING id',[key,req.body.username.toLowerCase(),encoded,req.body.role])).rows;
        if(!rows.length)throw new AppError(409,'USERNAME_EXISTS','Этот логин уже занят.');await audit(tx,actor,'staff.create',key,{role:req.body.role});return {id:key};
      });
    });
    admin.patch<{Params:{id:string};Body:{version:number;role:string;active:boolean;password?:string}}>('/staff/:id',{schema:schema('Роль, отключение или сброс пароля; отзывает сессии, только владелец',{params:object({id:uuid}),body:object({version,role:{enum:['owner','manager','viewer']},active:{type:'boolean'},password:str(128,12)},['version','role','active'])})},async req=>{
      const actor=await current(req);await authorize(db,actor,true,true);
      if(req.params.id===actor.id)throw new AppError(400,'SELF_EDIT','Свой пароль меняется в разделе «Мой пароль». Собственную роль и доступ менять нельзя.');
      const encoded=req.body.password?await passwordHash(req.body.password):null;
      return edit(actor,true,async tx=>{
        const b=req.body;const rows=(await tx.query('UPDATE staff SET role=$1,active=$2,password_hash=COALESCE($3,password_hash),version=version+1,failed_attempts=0,locked_until=NULL WHERE id=$4 AND version=$5 RETURNING id',[b.role,b.active,encoded,req.params.id,b.version])).rows;if(!rows.length)throw conflict();
        await tx.query('DELETE FROM staff_sessions WHERE staff_id=$1',[req.params.id]);await audit(tx,actor,'staff.update',req.params.id,{role:b.role,active:b.active,passwordReset:!!encoded});return {ok:true};
      });
    });
    admin.post<{Body:{currentPassword:string;password:string}}>('/password',{schema:schema('Сменить собственный пароль, завершив все сессии',{body:object({currentPassword:str(128,12),password:str(128,12)})}),config:{rateLimit:{max:5,timeWindow:'15 minutes'}}},async req=>{
      const actor=await current(req);const encoded=await passwordHash(req.body.password);
      await db.transaction(async tx=>{
        const u=(await tx.query('SELECT password_hash,active FROM staff WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
        if(!u?.active||!await verifyPassword(req.body.currentPassword,u.password_hash))throw new AppError(400,'INVALID_PASSWORD','Текущий пароль не совпадает.');
        await tx.query('UPDATE staff SET password_hash=$1,version=version+1 WHERE id=$2',[encoded,actor.id]);await tx.query('DELETE FROM staff_sessions WHERE staff_id=$1',[actor.id]);await audit(tx,actor,'staff.password',actor.id);
      });req.session.delete();return {ok:true};
    });
    const tables:Record<string,string>={catalog:'SELECT id,title,unit,price_minor,active FROM catalog ORDER BY id',content_blocks:'SELECT id,title,enabled,sort_order,version FROM content_blocks ORDER BY sort_order,id',customers:'SELECT id,name,phone,version,created_at FROM customers ORDER BY created_at DESC,id',orders:'SELECT id,status,arrival::text,departure::text,beds,total_minor,version FROM orders ORDER BY created_at DESC,id',outbox:'SELECT id,topic,created_at,delivered_at,attempts FROM outbox ORDER BY created_at DESC,id'};
    admin.get<{Querystring:{table?:string;page?:string}}>('/database',{schema:schema('Контролируемый просмотр БД; только владелец, без SQL и секретных таблиц',{querystring:object({table:{enum:Object.keys(tables)},page:{type:'string',pattern:'^[1-9][0-9]{0,5}$'}},[])})},async req=>{
      await authorize(db,await current(req),false,true);const table=req.query.table??'catalog';
      return {tables:Object.keys(tables),table,items:(await db.query(tables[table]+' LIMIT 25 OFFSET $1',[(Number(req.query.page??1)-1)*25])).rows,total:(await db.query('SELECT count(*)::integer AS n FROM '+table)).rows[0].n,outboxPending:(await db.query('SELECT count(*)::integer AS n FROM outbox WHERE delivered_at IS NULL')).rows[0].n};
    });
  },{prefix:'/api/v1/admin'});
}
