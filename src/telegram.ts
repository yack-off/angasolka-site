import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Database,Queryable} from './db.js';
import {AppError,type Trip,type OrderInput} from './contracts.js';
import {catalog,quote} from './pricing.js';
import {createOrder,trackOrder} from './orders.js';
import {authorize} from './admin-auth.js';
import {updateOrder} from './order-management.js';

export type TelegramConfig={secret:string;adminUserId:number;staffId:string;origin:string};
type Button={text:string;url?:string;callback_data?:string};
type Body={text:string;reply_markup?:{inline_keyboard:Button[][]}};
type Update={update_id:number;message?:{from?:{id:number;is_bot?:boolean};chat:{id:number;type:string};text?:string};callback_query?:{id:string;from:{id:number;is_bot?:boolean};message?:{chat:{id:number;type:string}};data?:string}};
type Draft={step?:'trip'|'name'|'phone'|'comment'|'confirm';trip?:Trip;name?:string;phone?:string;comment?:string;total?:number;pricingVersion?:number;nonce?:string};
export const money=(minor:number)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(minor/100);
const statuses:Record<string,string>={pending:'Ожидает обработки',contacted:'В работе',cancelled:'Отменена'};
export const statusText=(o:Record<string,any>)=>`Заявка ${o.id}\n${statuses[o.status]??o.status} · ${money(o.total_minor)}\nЭто заявка, наличие мест и бронь требуют отдельного подтверждения.`;
export async function enqueue(tx:Queryable,key:string,userId:number,body:Body,staffId?:string) {
  if(body.text.length>3500) {
    let remaining=body.text,part=0;
    while(remaining.length) {
      let end=Math.min(3500,remaining.length);
      if(/[\uD800-\uDBFF]/.test(remaining[end-1]))end--;
      const text=remaining.slice(0,end);remaining=remaining.slice(end);
      await enqueue(tx,`${key}:part:${part++}`,userId,{text,...remaining?{}:{reply_markup:body.reply_markup}},staffId);
    }
    return;
  }
  await tx.query('INSERT INTO telegram_deliveries(id,dedupe_key,user_id,staff_id,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING',[randomUUID(),key,userId,staffId??null,JSON.stringify(body)]);
}
export async function telegramActor(tx:Queryable,userId:number,c:TelegramConfig) {
  if(userId!==c.adminUserId)throw new AppError(403,'FORBIDDEN','Команда доступна сотруднику.');
  return authorize(tx,{id:c.staffId,username:'',role:'viewer'},true);
}
export async function adminCard(tx:Queryable,o:Record<string,any>,c:TelegramConfig):Promise<Body> {
  const linked=(await tx.query('SELECT user_id FROM telegram_orders WHERE order_id=$1',[o.id])).rows[0];
  const buttons:Button[][]=[[{text:'Открыть кабинет',url:c.origin+'/admin/'}]];
  if(o.status==='pending')buttons.unshift([{text:'Принять в работу',callback_data:`take:${o.id}:${o.version}`}]);
  if(linked)buttons.push([{text:'Написать гостю',url:`tg://user?id=${linked.user_id}`}]);
  return {text:statusText(o)+`\nКанал: ${o.source}\n${o.arrival} → ${o.departure} · мест: ${o.beds}`,reply_markup:{inline_keyboard:buttons}};
}
const help='Ангасолка\n/new — оставить заявку\n/my — мои заявки (последние 20)\n/link КОД — подключить статус заявки с сайта\n/stop — отключить отслеживание и удалить черновик\n/cancel — удалить черновик\n/admin — заявки сотрудника\nПодключая заявку, вы разрешаете уведомления о ней и переход сотрудника в ваш Telegram-профиль. Телефон не подтверждает владение заявкой.';
const invalid=(message:string)=>new AppError(400,'INVALID_INPUT',message);
function parseTrip(text:string):Trip {
  const parts=text.trim().split(/\s+/),[arrival,departure,beds,...extras]=parts;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(arrival??'')||!/^\d{4}-\d{2}-\d{2}$/.test(departure??'')||!/^\d{1,2}$/.test(beds??'')||Number(beds)>20||extras.length>30)throw invalid('Формат: ГГГГ-ММ-ДД ГГГГ-ММ-ДД количество_мест food=2 bath=1. Мест: 0–20.');
  const result:Trip={arrival,departure,beds:Number(beds),extras:{}};
  for(const item of extras) {
    const m=/^((?!bed$)[a-z][a-z0-9_-]{0,39})=(\d{1,3})$/.exec(item);
    if(!m||m[1]==='bed'||Number(m[2])>100||Object.hasOwn(result.extras,m[1]))throw invalid('Услуги: код=количество, от 0 до 100, без повторов.');
    Object.defineProperty(result.extras,m[1],{value:Number(m[2]),enumerable:true,writable:true,configurable:true});
  }
  return result;
}
async function preview(tx:Queryable,d:Draft) {
  await tx.query('SELECT id FROM pricing_policy WHERE id=1 FOR SHARE');
  const q=await quote(tx,d.trip!);d.total=q.totalMinor;d.pricingVersion=q.pricingVersion;d.nonce=randomBytes(12).toString('hex');d.step='confirm';
  return {text:`Проверьте заявку\n${d.trip!.arrival} → ${d.trip!.departure}\n${q.items.map(i=>`${i.title}: ${i.quantity} × ${money(i.unitPriceMinor)}`).join('\n')}\nСкидка: ${money(q.discountMinor)}\nИтого: ${money(q.totalMinor)}${q.demo?'\nТарифы демонстрационные, ещё не утверждены владельцем.':''}\nИмя: ${d.name}\nТелефон: ${d.phone}\nКомментарий: ${d.comment||'—'}\nНажимая «Отправить заявку», вы соглашаетесь на обработку указанных контактов для рассмотрения заявки и уведомления в Telegram, а также переход сотрудника в ваш Telegram-профиль. Наличие мест уточнит сотрудник. Оплата пока недоступна.`,reply_markup:{inline_keyboard:[[{text:'Отправить заявку',callback_data:'submit:'+d.nonce}],[{text:'Отменить',callback_data:'cancel:'+d.nonce}]]}};
}

export async function processTelegramUpdate(db:Database,u:Update,c:TelegramConfig) {
  const sender=u.callback_query?.from??u.message?.from,chat=u.callback_query?.message?.chat??u.message?.chat;
  if(!sender||sender.is_bot||!Number.isSafeInteger(sender.id)||sender.id<=0||!chat||chat.type!=='private'||chat.id!==sender.id)return;
  const uid=sender.id,text=(u.callback_query?.data??u.message?.text??'').trim();
  if(!text||text.length>4096)return;
  await db.transaction(async tx=>{
    const inserted=await tx.query('INSERT INTO telegram_updates(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id',[u.update_id]);
    if(!inserted.rows.length)return;
    await tx.query('INSERT INTO telegram_sessions(user_id) VALUES($1) ON CONFLICT DO NOTHING',[uid]);
    const session=(await tx.query('SELECT draft,expires_at FROM telegram_sessions WHERE user_id=$1 FOR UPDATE',[uid])).rows[0];
    let d:Draft=new Date(session.expires_at)>new Date()?session.draft:{};
    let sequence=0;
    const reply=(body:Body,staffId?:string)=>enqueue(tx,`update:${u.update_id}:${sequence++}`,uid,body,staffId);
    // A savepoint also rolls back idempotency/customer writes when a quote changes.
    await tx.query('SAVEPOINT telegram_action');
    try {
      if(text==='/start'||text==='/help')await reply({text:help});
      else if(text==='/stop') {
        await tx.query('DELETE FROM telegram_orders WHERE user_id=$1',[uid]);
        await tx.query('DELETE FROM telegram_deliveries WHERE user_id=$1 AND staff_id IS NULL AND delivered_at IS NULL',[uid]);
        d={};await reply({text:'Отслеживание отключено, черновик удалён. Сами заявки сохранены. Уже отправленные сообщения остаются в Telegram.'});
      } else if(text==='/cancel'||(u.callback_query&&text==='cancel:'+d.nonce)) {d={};await reply({text:'Черновик удалён. /new — новая заявка.'});}
      else if(text==='/new') {
        d={step:'trip'};
        const {products}=await catalog(tx);
        const lines=products.filter(p=>p.id!=='bed').map(p=>`${p.id} — ${p.title}, ${p.unit}: ${money(p.price_minor)}`);
        await reply({text:'Введите заезд, выезд и число мест через пробел; затем услуги код=количество. Даты: ГГГГ-ММ-ДД, по Иркутску.\n'+lines.join('\n')});
      } else if(text==='/my') {
        const orders=(await tx.query('SELECT o.id,o.status,o.total_minor FROM orders o JOIN telegram_orders t ON t.order_id=o.id WHERE t.user_id=$1 ORDER BY o.created_at DESC LIMIT 20',[uid])).rows;
        if(!orders.length)await reply({text:'Подключённых заявок нет. /new — создать; /link КОД — подключить с сайта.'});
        for(const o of orders)await reply({text:statusText(o)});
      } else if(text.startsWith('/link ')) {
        const token=text.slice(6).trim();if(!/^[a-f0-9]{64}$/.test(token))throw invalid('После /link укажите секретный код статуса из подтверждения на сайте.');
        const o=await trackOrder({query:(sql,params)=>tx.query(sql,params),transaction:fn=>fn(tx),close:async()=>{}},token);
        await tx.query('INSERT INTO telegram_orders(order_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[o.id,uid]);
        const linked=(await tx.query('SELECT user_id FROM telegram_orders WHERE order_id=$1',[o.id])).rows[0];
        if(Number(linked.user_id)!==uid)throw invalid('Заявка уже подключена к другому Telegram.');
        await reply({text:statusText(o)+'\nУведомления подключены. /stop — отключить.'});
      } else if(text==='/admin') {
        const actor=await telegramActor(tx,uid,c);
        const orders=(await tx.query("SELECT id,status,total_minor,source,arrival::text,departure::text,beds,version FROM orders WHERE status<>'cancelled' ORDER BY created_at DESC LIMIT 20")).rows;
        if(!orders.length)await reply({text:'Активных заявок нет.'},actor.id);
        for(const o of orders)await reply(await adminCard(tx,o,c),actor.id);
      } else if(u.callback_query&&text.startsWith('take:')) {
        const m=/^take:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([1-9][0-9]{0,9})$/.exec(text);if(!m)throw invalid('Некорректная кнопка.');
        const actor=await telegramActor(tx,uid,c);
        await updateOrder(tx,actor,m[1],{version:Number(m[2]),status:'contacted'});
        await reply({text:'Заявка принята в работу. Это ещё не подтверждение брони.'},actor.id);
      } else if(u.callback_query&&d.step==='confirm'&&text==='submit:'+d.nonce) {
        const input:OrderInput={...d.trip!,customer:{name:d.name!,phone:d.phone!},comment:d.comment!,consent:true,expectedTotalMinor:d.total!,pricingVersion:d.pricingVersion!,trackingToken:randomBytes(32).toString('hex')};
        const nested:Database={query:(sql,params)=>tx.query(sql,params),transaction:fn=>fn(tx),close:async()=>{}};
        const result=await createOrder(nested,input,`telegram:${uid}:${d.nonce}`,{source:'bot',userId:uid});
        d={};await reply({text:`Заявка ${result.order.id} отправлена. /my — проверить статус. Сотрудник уточнит наличие мест.`});
      } else if(u.callback_query)await reply({text:'Кнопка устарела. /my — статус, /admin — обновить список, /new — начать заново.'});
      else if(d.step==='trip') {d.trip=parseTrip(text);await quote(tx,d.trip);d.step='name';await reply({text:'Как к вам обращаться? Введите имя (до 80 символов).'});}
      else if(d.step==='name') {if(text.length>80)throw invalid('Имя — до 80 символов.');d.name=text;d.step='phone';await reply({text:'Введите телефон с кодом страны. Он нужен для связи по заявке.'});}
      else if(d.step==='phone') {if(text.length>30||!/^\+?\d{10,15}$/.test(text.replace(/[\s()-]/g,'')))throw invalid('Введите телефон с кодом страны: 10–15 цифр.');d.phone=text;d.step='comment';await reply({text:'Пожелания к поездке (до 1000 символов) или «-».'});}
      else if(d.step==='comment') {if(text.length>1000)throw invalid('Комментарий — до 1000 символов.');d.comment=text==='-'?'':text;await reply(await preview(tx,d));}
      else await reply({text:help});
      await tx.query('RELEASE SAVEPOINT telegram_action');
    } catch(error) {
      await tx.query('ROLLBACK TO SAVEPOINT telegram_action');
      if(!(error instanceof AppError))throw error;
      if(error.code==='PRICE_CHANGED')await reply(await preview(tx,d));
      else await reply({text:error.message});
    }
    await tx.query("UPDATE telegram_sessions SET draft=$2,expires_at=now()+interval '1 hour' WHERE user_id=$1",[uid,JSON.stringify(d)]);
  });
}

export async function registerTelegram(app:FastifyInstance,db:Database,c:TelegramConfig) {
  const user={type:'object',required:['id'],properties:{id:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},is_bot:{type:'boolean'}}};
  const chat={type:'object',required:['id','type'],properties:{id:{type:'integer',minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},type:{type:'string',maxLength:40}}};
  app.post<{Body:Update}>('/api/v1/telegram/webhook',{
    bodyLimit:64*1024,
    onRequest:async req=>{const secret=req.headers['x-telegram-bot-api-secret-token'];if(typeof secret!=='string'||Buffer.byteLength(secret)!==Buffer.byteLength(c.secret)||!timingSafeEqual(Buffer.from(secret),Buffer.from(c.secret)))throw new AppError(401,'UNAUTHORIZED','Недопустимый webhook.');},
    schema:{tags:['Telegram'],summary:'Telegram webhook: только приватные чаты, дедупликация update_id',security:[{telegramWebhook:[]}],body:{type:'object',required:['update_id'],properties:{update_id:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},message:{type:'object',required:['chat'],properties:{from:user,chat,text:{type:'string',maxLength:4096}}},callback_query:{type:'object',required:['id','from'],properties:{id:{type:'string',maxLength:200},from:user,data:{type:'string',maxLength:64},message:{type:'object',required:['chat'],properties:{chat}}}}}}}
  },async req=>{await processTelegramUpdate(db,req.body,c);return req.body.callback_query?{method:'answerCallbackQuery',callback_query_id:req.body.callback_query.id}:{ok:true};});
}
