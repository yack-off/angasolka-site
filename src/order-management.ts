import {randomUUID} from 'node:crypto';
import type {Queryable} from './db.js';
import {AppError} from './contracts.js';
import {authorize,audit,type Actor} from './admin-auth.js';

// Both staff HTTP routes and the Telegram adapter use this operation inside a transaction.
export async function updateOrder(tx:Queryable,actor:Actor,id:string,input:{version:number;status:string;comment?:string}) {
  actor=await authorize(tx,actor,true);
  if(!['pending','contacted','cancelled'].includes(input.status))throw new AppError(400,'INVALID_STATUS','Недопустимый статус.');
  const prior=(await tx.query('SELECT status,version,comment FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!prior)throw new AppError(404,'NOT_FOUND','Заявка не найдена.');
  if(prior.version!==input.version)throw new AppError(409,'VERSION_CONFLICT','Заявка уже изменена. Обновите список /admin.');
  if(prior.status==='cancelled'&&input.status!=='cancelled')throw new AppError(400,'INVALID_TRANSITION','Отменённую заявку нельзя возобновить.');
  await tx.query('UPDATE orders SET status=$1,comment=$2,version=version+1 WHERE id=$3',[input.status,input.comment??prior.comment,id]);
  const eventId=randomUUID(),payload={from:prior.status,status:input.status,version:input.version+1};
  await tx.query("INSERT INTO order_events(id,order_id,event_type,actor,payload) VALUES($1,$2,'order.updated',$3,$4)",[eventId,id,actor.id,JSON.stringify(payload)]);
  await tx.query("INSERT INTO outbox(id,event_id,topic,payload) VALUES($1,$2,'order.updated',$3)",[randomUUID(),eventId,JSON.stringify({orderId:id,eventId})]);
  await audit(tx,actor,'order.update',id,payload);
  return {ok:true};
}
