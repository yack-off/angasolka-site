import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,randomInt} from 'node:crypto';
import {connectDatabase,migrate,type Database} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {queueTelegramEvents,deliverTelegram} from '../src/telegram-worker.js';
import {telegramConfig} from '../src/telegram-config.js';
import {createOrder} from '../src/orders.js';
import {quote} from '../src/pricing.js';

let db:Database,app:Awaited<ReturnType<typeof buildApp>>,serial=0;
const staffId=randomUUID(),admin=10001,guest=10002,other=10003;
const config={secret:randomBytes(32).toString('hex'),staffId,adminUserId:admin,origin:'https://example.invalid'};
const date=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const trip={arrival:date(10),departure:date(12),beds:2,extras:{food:1}};
const phone=()=>String(randomInt(100000000000,999999999999));
const token=()=>randomBytes(32).toString('hex');
const update=(id:number,text:string,callback=false)=>({update_id:++serial,...callback?{callback_query:{id:String(serial),from:{id},message:{chat:{id,type:'private'}},data:text}}:{message:{from:{id},chat:{id,type:'private'},text}}});
const post=(payload:Record<string,unknown>,secret=config.secret)=>app.inject({method:'POST',url:'/api/v1/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':secret},payload});
const say=async(id:number,text:string,callback=false)=>{const r=await post(update(id,text,callback));assert.equal(r.statusCode,200,r.body);return r;};
const draft=async(id:number)=>(await db.query('SELECT draft FROM telegram_sessions WHERE user_id=$1',[id])).rows[0].draft;
const messages=async(id:number)=>(await db.query('SELECT body FROM telegram_deliveries WHERE user_id=$1 ORDER BY created_at,id',[id])).rows.map(r=>r.body);
const prepare=async(id:number)=>{
  await say(id,'/new');await say(id,`${trip.arrival} ${trip.departure} 2 food=1`);await say(id,'Тест');await say(id,phone());await say(id,'-');return draft(id);
};
before(async()=>{
  db=await connectDatabase(undefined,'memory://');await migrate(db);
  await db.query("INSERT INTO staff(id,username,password_hash,role) VALUES($1,'telegram-test','unused','owner')",[staffId]);
  app=await buildApp(db,{telegram:config,rateMax:10000});await app.ready();
});
after(async()=>{await app.close();await db.close();});

test('webhook requires secret; malformed updates rejected; group messages cannot access orders',async()=>{
  assert.equal((await post(update(guest,'/my'),'wrong')).statusCode,401);
  assert.equal((await post({update_id:'1'})).statusCode,400);
  assert.equal((await post({update_id:++serial,message:{from:{id:guest},chat:{id:-1,type:'group'},text:'/my'}})).statusCode,200);
  assert.equal((await messages(guest)).length,0);
  const spec=(await app.inject({url:'/api/v1/openapi.json'})).json();assert.ok(spec.paths['/api/v1/telegram/webhook']);
});

test('guest confirms snapshot; retries and old buttons create one bot order, ownership and event atomically',async()=>{
  const d=await prepare(guest);
  assert.equal((await db.query('SELECT id FROM orders')).rows.length,0);
  assert.ok(d.total>0);const u=update(guest,'submit:'+d.nonce,true);
  assert.equal((await post(u)).statusCode,200);assert.equal((await post(u)).statusCode,200);
  await say(guest,'submit:'+d.nonce,true);
  const orders=(await db.query('SELECT id,source,total_minor FROM orders')).rows;assert.equal(orders.length,1);assert.equal(orders[0].source,'bot');assert.equal(orders[0].total_minor,d.total);
  assert.equal((await db.query('SELECT * FROM telegram_orders WHERE order_id=$1',[orders[0].id])).rows[0].user_id,guest);
  assert.equal((await db.query('SELECT * FROM order_events WHERE order_id=$1',[orders[0].id])).rows.length,1);
  await say(other,'/my');assert.ok((await messages(other)).some(b=>b.text.includes('Подключённых заявок нет')));
  await say(guest,'/my');assert.ok((await messages(guest)).some(b=>b.text.includes(orders[0].id)));
});

test('changed prices require a new review and confirmation; failed creation rolls back all writes',async()=>{
  const d=await prepare(other);
  await db.query('UPDATE pricing_policy SET version=version+1');
  const before=(await db.query('SELECT count(*)::int AS n FROM customers')).rows[0].n;
  await say(other,'submit:'+d.nonce,true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM customers')).rows[0].n,before);
  const renewed=await draft(other);assert.notEqual(d.nonce,renewed.nonce);assert.ok(renewed.pricingVersion>d.pricingVersion);
  await say(other,'submit:'+d.nonce,true);assert.equal((await db.query('SELECT count(*)::int AS n FROM customers')).rows[0].n,before);
  await say(other,'submit:'+renewed.nonce,true);assert.equal((await db.query('SELECT count(*)::int AS n FROM customers')).rows[0].n,before+1);
});

test('website code grants only minimal tracking; another Telegram cannot replace a subscription',async()=>{
  const q=await quote(db,trip),trackingToken=token();
  const created=await createOrder(db,{...trip,customer:{name:'Тест',phone:phone()},comment:'',consent:true,expectedTotalMinor:q.totalMinor,pricingVersion:q.pricingVersion,trackingToken},randomUUID());
  await say(guest,'/link '+trackingToken);await say(other,'/link '+trackingToken);
  assert.equal(Number((await db.query('SELECT user_id FROM telegram_orders WHERE order_id=$1',[created.order.id])).rows[0].user_id),guest);
  assert.ok((await messages(other)).some(b=>b.text.includes('другому Telegram')));
  assert.equal((await db.query('SELECT * FROM telegram_sessions WHERE user_id=$1',[guest])).rows[0].draft.trackingToken,undefined);
});

test('staff action checks identity and current role, updates shared status, rejects stale version',async()=>{
  await say(admin,'take:'+ '-'.repeat(36)+':1',true);
  const o=(await db.query('SELECT id,version FROM orders LIMIT 1')).rows[0];
  await say(guest,`take:${o.id}:${o.version}`,true);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1',[o.id])).rows[0].status,'pending');
  await say(admin,`take:${o.id}:${o.version}`,true);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1',[o.id])).rows[0].status,'contacted');
  await say(admin,`take:${o.id}:${o.version}`,true);
  assert.equal((await db.query('SELECT version FROM orders WHERE id=$1',[o.id])).rows[0].version,o.version+1);
  assert.equal((await db.query("SELECT * FROM admin_audit WHERE entity_id=$1 AND action='order.update'",[o.id])).rows.length,1);
  await db.query("UPDATE staff SET role='viewer' WHERE id=$1",[staffId]);
  await say(admin,`take:${o.id}:${o.version+1}`,true);
  assert.equal((await db.query('SELECT version FROM orders WHERE id=$1',[o.id])).rows[0].version,o.version+1);
  await db.query("UPDATE staff SET role='owner' WHERE id=$1",[staffId]);
});

test('outbox queues events once; delivery retries without saving secret errors; revoked staff receives nothing',async()=>{
  assert.ok(await queueTelegramEvents(db,config)>0);assert.equal(await queueTelegramEvents(db,config),0);
  const eventMessages=(await db.query("SELECT body FROM telegram_deliveries WHERE dedupe_key LIKE 'event:%:staff'")).rows;
  assert.ok(eventMessages.some(r=>r.body.reply_markup.inline_keyboard.flat().some((b:any)=>b.url?.startsWith('tg://user?id='))));
  await db.query('UPDATE telegram_deliveries SET delivered_at=now()');
  const id=randomUUID();await db.query("INSERT INTO telegram_deliveries(id,dedupe_key,user_id,body) VALUES($1::uuid,$1::text,$2,'{\"text\":\"test\"}')",[id,guest]);
  await deliverTelegram(db,async()=>{throw new Error('sensitive transport error');});
  let row=(await db.query('SELECT * FROM telegram_deliveries WHERE id=$1',[id])).rows[0];assert.equal(row.attempts,1);assert.equal(row.error_code,'SEND_FAILED');assert.equal(row.delivered_at,null);
  assert.equal(await deliverTelegram(db,async()=>{assert.fail('Backoff ignored');}),false);
  await db.query('UPDATE telegram_deliveries SET available_at=now() WHERE id=$1',[id]);let sent=0;
  await deliverTelegram(db,async()=>{sent++;});assert.equal(sent,1);
  row=(await db.query('SELECT * FROM telegram_deliveries WHERE id=$1',[id])).rows[0];assert.ok(row.delivered_at);
  await say(admin,'/admin');await db.query('UPDATE staff SET active=false WHERE id=$1',[staffId]);
  await deliverTelegram(db,async()=>{assert.fail('Disabled staff received a message');});
  await db.query('UPDATE staff SET active=true WHERE id=$1',[staffId]);
});

test('stop removes subscriptions and pending guest notifications; invalid trip bounds cannot create a draft quote',async()=>{
  await say(guest,'/stop');assert.equal((await db.query('SELECT * FROM telegram_orders WHERE user_id=$1',[guest])).rows.length,0);
  await say(guest,'/new');await say(guest,`${trip.arrival} ${trip.departure} 21 food=999`);
  assert.equal((await draft(guest)).step,'trip');assert.equal((await draft(guest)).total,undefined);
});

test('Telegram delivery is disabled by default and incomplete configuration fails closed',()=>{
  assert.equal(telegramConfig({},config.origin),undefined);
  assert.throws(()=>telegramConfig({TELEGRAM_ENABLED:'true'},config.origin));
});
