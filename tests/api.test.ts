import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {connectDatabase,migrate,type Database} from '../src/db.js';
import {localToday} from '../src/pricing.js';

let db:Database,app:Awaited<ReturnType<typeof buildApp>>;
const date=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const trip={arrival:date(10),departure:date(15),beds:2,extras:{bath:2,food:4}};
const token=()=>randomBytes(32).toString('hex');
const key=()=>randomUUID();
const request=async(overrides={})=>{
  const q=(await app.inject({method:'POST',url:'/api/v1/quotes',payload:trip})).json();
  return {...trip,customer:{name:'Тестовый гость',phone:'+7 999 000-00-00'},comment:'Тест',consent:true,expectedTotalMinor:q.totalMinor,pricingVersion:q.pricingVersion,trackingToken:token(),...overrides};
};
before(async()=>{db=await connectDatabase(process.env.TEST_DATABASE_URL,'memory://');await migrate(db);app=await buildApp(db,{rateMax:10000});await app.ready();});
after(async()=>{await app.close();await db.close();});
test('server calculates bed-nights, stay-only discount and service quantities in kopecks',async()=>{
  const response=await app.inject({method:'POST',url:'/api/v1/quotes',payload:trip});
  assert.equal(response.statusCode,200);const q=response.json();
  assert.equal(q.subtotalMinor,2160000);assert.equal(q.discountMinor,150000);assert.equal(q.totalMinor,2010000);
  assert.equal(q.items.find((i:any)=>i.productId==='bed').quantity,10);
});
test('rejects malformed dates, past dates, empty and negative orders, unknown fields, oversized quantities',async()=>{
  for(const payload of [{...trip,arrival:'2027-02-30'},{...trip,arrival:'2020-01-01'},{...trip,departure:trip.arrival},{...trip,beds:0,extras:{}},{...trip,beds:-1},{...trip,extras:{bath:101}},{...trip,extras:{unknown:1}},{...trip,beds:'2'},{...trip,total:1}]){
    const r=await app.inject({method:'POST',url:'/api/v1/quotes',payload});assert.equal(r.statusCode,400,JSON.stringify(payload));
  }
});
test('service-only trip does not charge beds or discount services',async()=>{
  const r=await app.inject({method:'POST',url:'/api/v1/quotes',payload:{...trip,beds:0,extras:{food:2}}});assert.equal(r.json().totalMinor,130000);assert.equal(r.json().discountMinor,0);
});
test('parallel retries atomically create one order, audit event and outbox event',async()=>{
  const payload=await request(),idempotency=key();
  const replies=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':idempotency},payload})));
  assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,201]);
  const id=replies[0].json().order.id;assert.equal(id,replies[1].json().order.id);
  for(const table of ['order_events','order_items']){const rows=(await db.query(`SELECT * FROM ${table} WHERE order_id=$1`,[id])).rows;assert.equal(rows.length,table==='order_items'?3:1);}
  const outbox=(await db.query('SELECT * FROM outbox WHERE payload->>\'orderId\'=$1',[id])).rows;assert.equal(outbox.length,1);
  const changed=await app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':idempotency},payload:{...payload,comment:'Изменён'}});assert.equal(changed.statusCode,409);
});
test('tracking requires secret; returns no contacts or wishes; unknown token is 404',async()=>{
  const payload=await request();const created=await app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':key()},payload});assert.equal(created.statusCode,201);
  const response=await app.inject({url:'/api/v1/orders/status',headers:{authorization:'Bearer '+payload.trackingToken}});assert.equal(response.statusCode,200);assert.equal(response.json().status,'pending');
  assert.equal(response.json().customer,undefined);assert.equal(response.json().comment,undefined);assert.equal(response.json().tracking_hash,undefined);
  assert.equal((await app.inject({url:'/api/v1/orders/status'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/v1/orders/status',headers:{authorization:'Bearer '+token()}})).statusCode,404);
});
test('price tampering rolls back customer, order and idempotency writes',async()=>{
  const before=(await db.query('SELECT count(*)::integer AS n FROM customers')).rows[0].n;
  const payload=await request({expectedTotalMinor:1});const idempotency=key();
  const r=await app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':idempotency},payload});assert.equal(r.statusCode,409);assert.equal(r.json().error.code,'PRICE_CHANGED');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM customers')).rows[0].n,before);
});
test('contacts, consent, public source, JSON content type and origin are validated',async()=>{
  for(const patch of [{consent:false},{customer:{name:' ',phone:'+79990000000'}},{customer:{name:'Имя',phone:'abcdefghij'}},{source:'admin'}]){
    const r=await app.inject({method:'POST',url:'/api/v1/orders',headers:{'idempotency-key':key()},payload:await request(patch)});assert.equal(r.statusCode,400);
  }
  assert.equal((await app.inject({method:'POST',url:'/api/v1/quotes',headers:{origin:'https://evil.example'},payload:trip})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/quotes',headers:{'content-type':'text/plain'},payload:'test'})).statusCode,400);
});
test('health, readiness, OpenAPI and public files respond; secrets and source are not served',async()=>{
  for(const url of ['/','/status.html','/api/v1/health','/api/v1/ready','/api/v1/openapi.json'])assert.equal((await app.inject({url})).statusCode,200,url);
  for(const url of ['/src/db.ts','/migrations/001_initial.sql'])assert.equal((await app.inject({url})).statusCode,404,url);
  assert.equal((await app.inject({url:'/.env'})).statusCode,403);
  const spec=(await app.inject({url:'/api/v1/openapi.json'})).json();assert.ok(spec.paths['/api/v1/orders'].post.requestBody);
  assert.match((await app.inject({url:'/'})).headers['content-security-policy'] as string,/frame-ancestors 'none'/);
});
test('database data and migration version survive a close and reopen',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'angasolka-db-'));
  try{
    const nested=join(directory,'nested','postgres');
    const first=await connectDatabase(undefined,nested);await migrate(first);await first.query("UPDATE catalog SET price_minor=123456 WHERE id='bed'");await first.close();
    const second=await connectDatabase(undefined,nested);await migrate(second);assert.equal((await second.query("SELECT price_minor FROM catalog WHERE id='bed'")).rows[0].price_minor,123456);await second.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('rate limiting applies and Baikal timezone crosses UTC date boundary',async()=>{
  const limited=await buildApp(db,{rateMax:1});
  try{assert.equal((await limited.inject({url:'/api/v1/health'})).statusCode,200);assert.equal((await limited.inject({url:'/api/v1/health'})).statusCode,429);}finally{await limited.close();}
  assert.equal(localToday(new Date('2026-09-14T17:00:00Z')),'2026-09-15');
});
