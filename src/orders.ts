import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { AppError, type OrderInput } from './contracts.js';
import { quote } from './pricing.js';
export const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function canonical(value:any):string {
  if(value&&typeof value==='object'&&!Array.isArray(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export async function createOrder(db:Database,input:OrderInput,key:string,channel:{source:'bot';userId:number}|undefined=undefined) {
  const name=input.customer.name.trim();
  const phone=input.customer.phone.replace(/[\s()\-]/g,'');
  if(!name||!/^\+?\d{10,15}$/.test(phone))throw new AppError(400,'INVALID_CONTACT','Проверьте имя и телефон с кодом страны.');
  const requestHash=hash(canonical(channel?{...input,channel}:input)),keyHash=hash(key);
  return db.transaction(async tx=>{
    // Conflict waits for the first transaction, so simultaneous retries create one order.
    await tx.query('INSERT INTO idempotency_keys(key_hash,request_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[keyHash,requestHash]);
    const prior=(await tx.query('SELECT * FROM idempotency_keys WHERE key_hash=$1 FOR UPDATE',[keyHash])).rows[0];
    if(prior.request_hash!==requestHash)throw new AppError(409,'IDEMPOTENCY_CONFLICT','Данные повторной заявки изменились. Начните новую отправку.');
    if(prior.order_id) {
      const order=(await tx.query('SELECT id,status,quote,created_at FROM orders WHERE id=$1',[prior.order_id])).rows[0];
      return {order,replayed:true};
    }
    // Future tariff writes must lock/update this policy row before changing products.
    await tx.query('SELECT id FROM pricing_policy WHERE id=1 FOR SHARE');
    const calculated=await quote(tx,input);
    if(calculated.totalMinor!==input.expectedTotalMinor||calculated.pricingVersion!==input.pricingVersion)throw new AppError(409,'PRICE_CHANGED','Стоимость изменилась. Проверьте новый расчёт перед отправкой.');
    const customerId=randomUUID(),id=randomUUID(),eventId=randomUUID();
    // A submitted phone number is not verified identity: never auto-merge customers by phone.
    await tx.query('INSERT INTO customers(id,name,phone) VALUES($1,$2,$3)',[customerId,name,phone]);
    const order=(await tx.query(`INSERT INTO orders(id,customer_id,source,arrival,departure,beds,comment,quote,total_minor,tracking_hash,consent_version)
      VALUES($1,$2,$10,$3,$4,$5,$6,$7,$8,$9,$11) RETURNING id,status,quote,created_at`,
      [id,customerId,input.arrival,input.departure,input.beds,input.comment.trim(),JSON.stringify(calculated),calculated.totalMinor,hash(input.trackingToken),channel?.source??'website',channel?'telegram-request-v1':'local-request-v1'])).rows[0];
    if(channel)await tx.query('INSERT INTO telegram_orders(order_id,user_id) VALUES($1,$2)',[id,channel.userId]);
    for(const item of calculated.items)await tx.query('INSERT INTO order_items VALUES($1,$2,$3,$4,$5,$6,$7)',[id,item.productId,item.title,item.unit,item.quantity,item.unitPriceMinor,item.totalMinor]);
    await tx.query("INSERT INTO order_events(id,order_id,event_type,actor,payload) VALUES($1,$2,'order.created',$4,$3)",[eventId,id,JSON.stringify({status:'pending'}),channel?.source??'website']);
    await tx.query("INSERT INTO outbox(id,event_id,topic,payload) VALUES($1,$2,'order.created',$3)",[randomUUID(),eventId,JSON.stringify({orderId:id,eventId})]);
    await tx.query('UPDATE idempotency_keys SET order_id=$1 WHERE key_hash=$2',[id,keyHash]);
    return {order,replayed:false};
  });
}
export async function trackOrder(db:Database,token:string) {
  const order=(await db.query<{id:string;status:string;total_minor:number;created_at:string}>('SELECT id,status,total_minor,created_at FROM orders WHERE tracking_hash=$1',[hash(token)])).rows[0];
  if(!order)throw new AppError(404,'ORDER_NOT_FOUND','Заявка не найдена. Проверьте код.');
  return {...order,currency:'RUB',availability:'requires_confirmation'};
}
