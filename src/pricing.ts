import type { Queryable } from './db.js';
import { AppError, type Trip } from './contracts.js';
export type Product={id:string;title:string;unit:string;price_minor:number;description:string;category:string;image_url:string;sort_order:number};
export type Policy={version:number;demo:boolean;discount_nights:number;discount_percent:number};
export async function catalog(db:Queryable) {
  const products=(await db.query<Product>('SELECT id,title,unit,price_minor,description,category,image_url,sort_order FROM catalog WHERE active=true ORDER BY sort_order,id')).rows;
  const policy=(await db.query<Policy>('SELECT version,demo,discount_nights,discount_percent FROM pricing_policy WHERE id=1')).rows[0];
  if(!policy) throw new Error('Pricing policy is missing');
  return {products,policy,currency:'RUB',timezone:'Asia/Irkutsk'};
}
export function localToday(now=new Date()) {return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Irkutsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export async function quote(db:Queryable,trip:Trip,now=new Date()) {
  const parse=(value:string)=>{
    const d=new Date(value+'T00:00:00Z');
    if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value) throw new AppError(400,'INVALID_DATE','Укажите существующие даты.');
    return d.getTime();
  };
  const nights=(parse(trip.departure)-parse(trip.arrival))/86400000;
  if(trip.arrival<localToday(now)||nights<1||nights>365||trip.arrival>localToday(new Date(now.getTime()+730*86400000))) throw new AppError(400,'INVALID_PERIOD','Заезд — в ближайшие два года, проживание — от 1 до 365 ночей.');
  const {products,policy}=await catalog(db);
  const requested={...trip.extras,bed:trip.beds*nights};
  const items=[];
  for(const [id,quantity] of Object.entries(requested)) {
    if(!quantity)continue;
    const product=products.find(p=>p.id===id);
    if(!product)throw new AppError(400,'SERVICE_UNAVAILABLE','Услуга недоступна. Обновите страницу.');
    items.push({productId:id,title:product.title,unit:product.unit,quantity,unitPriceMinor:product.price_minor,totalMinor:product.price_minor*quantity});
  }
  if(!items.length)throw new AppError(400,'EMPTY_ORDER','Выберите проживание или услуги.');
  const subtotalMinor=items.reduce((sum,p)=>sum+p.totalMinor,0);
  const stay=items.find(p=>p.productId==='bed')?.totalMinor??0;
  const discountMinor=nights>=policy.discount_nights?Math.round(stay*policy.discount_percent/100):0;
  if(subtotalMinor-discountMinor<1||subtotalMinor>2147483647)throw new AppError(400,'TOTAL_OUT_OF_RANGE','Сумма поездки должна быть от 1 копейки до 21 474 836,47 ₽. Измените состав поездки.');
  return {currency:'RUB',demo:policy.demo,pricingVersion:policy.version,nights,items,subtotalMinor,discountMinor,totalMinor:subtotalMinor-discountMinor,availability:'requires_confirmation'};
}
