import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import {connectDatabase,migrate,type Database} from '../src/db.js';
import {hash} from '../src/orders.js';
let db:Database,app:Awaited<ReturnType<typeof buildApp>>,cookie:string;
const origin='http://127.0.0.1:4180',password=randomBytes(24).toString('hex');
const cookies=(r:any)=>String(r.headers['set-cookie']).split(';')[0];
async function call(method:'GET'|'POST'|'PUT'|'PATCH',path:string,payload?:any,auth=cookie){return app.inject({method,url:'/api/v1/admin'+path,headers:{origin,cookie:auth??''},...(payload?{payload}:{})});}
before(async()=>{db=await connectDatabase(undefined,'memory://');await migrate(db);await migrate(db);app=await buildApp(db,{localSetup:true,rateMax:10000});await app.ready();});
after(async()=>{await app.close();await db.close();});
test('admin API is closed, setup is local, origin is mandatory and bootstrap is single-use',async()=>{
  for(const path of ['/catalog','/content','/orders','/metrics','/audit','/staff','/database','/media'])assert.equal((await call('GET',path,undefined,'')).statusCode,401,path);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/setup',payload:{username:'owner',password}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/setup',remoteAddress:'192.0.2.1',headers:{origin},payload:{username:'owner',password}})).statusCode,403);
  const setup=await call('POST','/setup',{username:'owner',password},'');assert.equal(setup.statusCode,200,setup.body);cookie=cookies(setup);
  assert.match(String(setup.headers['set-cookie']),/HttpOnly/);assert.match(String(setup.headers['set-cookie']),/SameSite=Strict/i);assert.match(String(setup.headers['set-cookie']),/Path=\/api\/v1\/admin/);
  assert.equal((await call('POST','/setup',{username:'other',password})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:'/api/v1/admin/catalog',headers:{origin:'https://evil.example',cookie},payload:{}})).statusCode,403);
  assert.equal((await call('GET','/session')).json().user.role,'owner');
});
test('content changes persist, concurrent edit is rejected and public HTML is not trusted markup',async()=>{
  const blocks=(await call('GET','/content')).json().blocks;
  const b=blocks.find((x:any)=>x.id==='stay');const fields=b.fields.map((f:any)=>({...f}));fields.find((f:any)=>f.type==='text').value='<img src=x onerror=alert(1)>';
  const payload={title:b.title,enabled:false,sort_order:25,fields,version:b.version};
  assert.equal((await call('PUT','/content/stay',payload)).statusCode,200);
  assert.equal((await call('PUT','/content/stay',payload)).statusCode,409);
  const publicBlock=(await app.inject({url:'/api/v1/content'})).json().blocks.find((x:any)=>x.id==='stay');assert.equal(publicBlock.enabled,false);assert.equal(publicBlock.fields[0].value,fields[0].value);
  payload.version++;payload.fields=fields.map((f:any)=>f.type==='image'?{...f,value:'https://evil.example/pixel'}:f);
  assert.equal((await call('PUT','/content/stay',payload)).statusCode,400);
  const hero=blocks.find((x:any)=>x.id==='hero');assert.equal((await call('PUT','/content/hero',{title:hero.title,enabled:false,sort_order:0,fields:hero.fields,version:hero.version})).statusCode,400);
});
test('catalog edits version prices, support new services and preserve historical order snapshots',async()=>{
  const arrival=new Date(Date.now()+10*86400000).toISOString().slice(0,10),departure=new Date(Date.now()+12*86400000).toISOString().slice(0,10);
  const trip={arrival,departure,beds:1,extras:{}};
  const q=(await app.inject({method:'POST',url:'/api/v1/quotes',payload:trip})).json();
  const order=(await app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':randomUUID()},payload:{...trip,customer:{name:'Проверка',phone:'+'+'0'.repeat(11)},comment:'',consent:true,expectedTotalMinor:q.totalMinor,pricingVersion:q.pricingVersion,trackingToken:randomBytes(32).toString('hex')}})).json().order;
  const c=(await call('GET','/catalog')).json();const bed=c.products.find((p:any)=>p.id==='bed');
  assert.equal((await call('PUT','/catalog',{...bed,price_minor:bed.price_minor+100,version:c.policy.version})).statusCode,200);
  assert.equal((await call('PUT','/catalog',{...bed,version:c.policy.version})).statusCode,409);
  const after=(await call('GET','/orders/'+order.id)).json().order;assert.equal(after.total_minor,q.totalMinor);assert.equal(after.quote.items[0].unitPriceMinor,q.items[0].unitPriceMinor);
  const stale=await app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':randomUUID()},payload:{...trip,customer:{name:'Проверка',phone:'+'+'0'.repeat(11)},comment:'',consent:true,expectedTotalMinor:q.totalMinor,pricingVersion:q.pricingVersion,trackingToken:randomBytes(32).toString('hex')}});assert.equal(stale.statusCode,409);
  const created=await call('PUT','/catalog',{id:'new-service',title:'Новая услуга',unit:'штука',price_minor:12345,description:'Текст',category:'comfort',image_url:'',sort_order:1,active:true,version:c.policy.version+1});assert.equal(created.statusCode,200,created.body);
  const quote=(await app.inject({method:'POST',url:'/api/v1/quotes',payload:{...trip,beds:0,extras:{'new-service':2}}})).json();assert.equal(quote.totalMinor,24690);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/quotes',payload:{...trip,extras:{bed:1}}})).statusCode,400);
  const beforeAudit=(await db.query('SELECT count(*)::int AS n FROM admin_audit')).rows[0].n;
  const status=await call('PATCH','/orders/'+order.id,{version:after.version,status:'contacted',comment:'Уточнение'});assert.equal(status.statusCode,200,status.body);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_audit')).rows[0].n,beforeAudit+1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM outbox WHERE topic='order.updated'")).rows[0].n,1);
  assert.equal((await call('PATCH','/orders/'+order.id,{version:after.version,status:'cancelled',comment:''})).statusCode,409);
  assert.equal((await call('PATCH','/orders/'+order.id,{version:after.version+1,status:'confirmed',comment:''})).statusCode,400);
  assert.equal((await call('PATCH','/orders/'+order.id,{version:after.version+1,status:'cancelled',comment:''})).statusCode,200);
  assert.equal((await call('PATCH','/orders/'+order.id,{version:after.version+2,status:'pending',comment:''})).statusCode,400);
});
test('readers cannot write, managers cannot change prices or roles, revocation invalidates an existing cookie',async()=>{
  for(const role of ['viewer','manager']){
    const created=await call('POST','/staff',{username:role,password,role});assert.equal(created.statusCode,200,created.body);const id=created.json().id;
    const login=await call('POST','/login',{username:role,password},'');assert.equal(login.statusCode,200,login.body);const session=cookies(login);
    assert.equal((await call('GET','/orders',undefined,session)).statusCode,200);
    assert.equal((await call('GET','/database',undefined,session)).statusCode,403);
    assert.equal((await call('POST','/staff',{username:'intruder',password,role:'owner'},session)).statusCode,403);
    const c=(await call('GET','/catalog')).json();assert.equal((await call('PUT','/catalog',{...c.products[0],version:c.policy.version},session)).statusCode,403);
    const block=await call('POST','/content',{title:'Проверка роли'},session);assert.equal(block.statusCode,role==='viewer'?403:200,block.body);
    assert.equal((await call('PATCH','/staff/'+id,{role,active:false,version:1})).statusCode,200);
    assert.equal((await call('GET','/orders',undefined,session)).statusCode,401);
  }
});
test('uploaded images are decoded, metadata removed and served; external media and SVG are rejected',async()=>{
  const png=await sharp({create:{width:10,height:10,channels:3,background:'#235e48'}}).png().toBuffer();
  const upload=await call('POST','/media',{title:'Тестовое изображение',alt:'Зелёный квадрат',data:png.toString('base64')});assert.equal(upload.statusCode,200,upload.body);
  const response=await app.inject({url:upload.json().url});assert.equal(response.statusCode,200);assert.equal(response.headers['content-type'],'image/webp');assert.equal((await sharp(response.rawPayload).metadata()).width,10);
  const svg=await call('POST','/media',{title:'Недопустимо',alt:'',data:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')});assert.equal(svg.statusCode,400);
  assert.equal((await call('GET','/database?table=staff')).statusCode,400);
  assert.equal((await call('GET','/database?table=orders%3BDROP%20TABLE%20staff')).statusCode,400);
  assert.equal((await call('GET','/media?page=0')).statusCode,400);
});
test('audit/outbox do not contain passwords or contacts, metric totals come from persisted orders',async()=>{
  const auditRows=JSON.stringify((await db.query('SELECT * FROM admin_audit')).rows);assert.ok(!auditRows.includes(password));assert.ok(!auditRows.includes('+'+'0'.repeat(11)));
  const metrics=(await call('GET','/metrics')).json();assert.equal(metrics.summary.orders,1);assert.equal(metrics.summary.cancelled,1);assert.equal(metrics.services.length,0);
  assert.equal((await call('GET','/metrics?from=2026-01-02&to=2026-01-01')).statusCode,400);
  const database=(await call('GET','/database?table=orders')).json();assert.ok(!JSON.stringify(database).includes('tracking_hash'));
  const spec=(await app.inject({url:'/api/v1/openapi.json'})).json();assert.ok(spec.paths['/api/v1/admin/catalog'].put);assert.ok(spec.components.securitySchemes.staffSession);
});
test('logout revokes even a copied session cookie',async()=>{
  assert.equal((await call('POST','/logout',{})).statusCode,200);assert.equal((await call('GET','/orders')).statusCode,401);
  const u=(await db.query("SELECT * FROM staff WHERE username='owner'")).rows[0];assert.notEqual(u.password_hash,password);assert.ok(!u.password_hash.includes(hash(password)));
});
