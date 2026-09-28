import {randomUUID} from 'node:crypto';
import type {Database} from './db.js';
import {adminCard,enqueue,statusText,type TelegramConfig} from './telegram.js';

// Each consumer has its own receipt; existing outbox rows remain available to future channels.
export async function queueTelegramEvents(db:Database,c:TelegramConfig) {
  return db.transaction(async tx=>{
    const staffActive=(await tx.query("SELECT id FROM staff WHERE id=$1 AND active=true AND role IN ('owner','manager')",[c.staffId])).rows.length>0;
    const events=(await tx.query("SELECT b.event_id,b.payload FROM outbox b WHERE b.topic IN ('order.created','order.updated') AND NOT EXISTS (SELECT 1 FROM telegram_events t WHERE t.event_id=b.event_id) ORDER BY b.created_at,b.id LIMIT 20 FOR UPDATE OF b SKIP LOCKED")).rows;
    for(const event of events) {
      const o=(await tx.query('SELECT id,status,total_minor,source,arrival::text,departure::text,beds,version FROM orders WHERE id=$1',[event.payload.orderId])).rows[0];
      if(!o)throw new Error('Missing order');
      if(staffActive)await enqueue(tx,`event:${event.event_id}:staff`,c.adminUserId,await adminCard(tx,o,c),c.staffId);
      const linked=(await tx.query('SELECT user_id FROM telegram_orders WHERE order_id=$1',[o.id])).rows[0];
      if(linked)await enqueue(tx,`event:${event.event_id}:guest`,Number(linked.user_id),{text:statusText(o)});
      await tx.query('INSERT INTO telegram_events(event_id) VALUES($1)',[event.event_id]);
    }
    // Remove contact-bearing drafts after expiry, even if the guest never returns.
    await tx.query("UPDATE telegram_sessions SET draft='{}' WHERE expires_at<=now() AND draft<>'{}'::jsonb");
    await tx.query("UPDATE telegram_deliveries SET body='{}' WHERE delivered_at<now()-interval '7 days' AND body<>'{}'::jsonb");
    return events.length;
  });
}
export type TelegramSender=(userId:number,body:Record<string,unknown>)=>Promise<void>;
export async function deliverTelegram(db:Database,send:TelegramSender) {
  const lease=randomUUID();
  const job=await db.transaction(async tx=>{
    const row=(await tx.query("SELECT id,user_id,staff_id,body,attempts FROM telegram_deliveries WHERE delivered_at IS NULL AND attempts<10 AND available_at<=now() ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
    if(!row)return;
    if(row.staff_id&&!(await tx.query("SELECT id FROM staff WHERE id=$1 AND active=true AND role IN ('owner','manager')",[row.staff_id])).rows.length) {
      await tx.query("UPDATE telegram_deliveries SET delivered_at=now(),error_code='STAFF_REVOKED',body='{}' WHERE id=$1",[row.id]);return;
    }
    await tx.query("UPDATE telegram_deliveries SET attempts=attempts+1,lease_id=$2,available_at=now()+interval '1 minute' WHERE id=$1",[row.id,lease]);return row;
  });
  if(!job)return false;
  try {
    await send(Number(job.user_id),job.body);
    await db.query('UPDATE telegram_deliveries SET delivered_at=now(),lease_id=NULL,error_code=NULL WHERE id=$1 AND lease_id=$2',[job.id,lease]);
  } catch {
    // Never persist API response/error text: it can contain the bot token or guest data.
    await db.query("UPDATE telegram_deliveries SET lease_id=NULL,error_code='SEND_FAILED',available_at=now()+($3::integer * interval '1 second') WHERE id=$1 AND lease_id=$2",[job.id,lease,Math.min(3600,30*2**job.attempts)]);
  }
  return true;
}
export function telegramSender(token:string):TelegramSender {
  return async(userId,body)=>{
    try {
      const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,chat_id:userId}),signal:AbortSignal.timeout(10000)});
      const data=await response.json() as {ok?:boolean};
      if(!response.ok||!data.ok)throw new Error('SEND_FAILED');
    } catch {throw new Error('TELEGRAM_SEND_FAILED');}
  };
}
export function startTelegramWorker(db:Database,c:TelegramConfig,send:TelegramSender,onError:()=>void) {
  let stopped=false,running:Promise<void>|undefined;
  const tick=()=>{if(stopped||running)return;running=(async()=>{try{await queueTelegramEvents(db,c);for(let i=0;i<20&&!stopped;i++)if(!await deliverTelegram(db,send))break;}catch{onError();}})().finally(()=>{running=undefined;});};
  const timer=setInterval(tick,2000);timer.unref();tick();
  return async()=>{stopped=true;clearInterval(timer);await running;};
}
