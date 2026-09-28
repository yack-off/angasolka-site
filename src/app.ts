import {registerTelegram,type TelegramConfig} from './telegram.js';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import { fileURLToPath } from 'node:url';
import type { Database } from './db.js';
import { AppError, orderSchema, tripSchema, type Trip, type OrderInput } from './contracts.js';
import { catalog, quote } from './pricing.js';
import { createOrder,trackOrder } from './orders.js';
import {randomBytes} from 'node:crypto';
import {registerAdmin,metric} from './admin.js';
import type {SecureContextOptions} from 'node:tls';

export async function buildApp(db:Database,options:{telegram?:TelegramConfig;origin?:string;logger?:boolean;rateMax?:number;sessionKey?:Buffer;localSetup?:boolean;https?:SecureContextOptions;trustProxy?:false|'loopback'}={}) {
  const origin=options.origin??'http://127.0.0.1:4180';
  const app=Fastify({logger:options.logger?{redact:['req.headers.authorization','req.headers.cookie','req.headers.idempotency-key','req.headers.x-telegram-bot-api-secret-token'],serializers:{req:req=>({method:req.method,url:req.url.split('?')[0],hostname:req.hostname})}}:false,
    ...(options.https?{https:options.https}:{}),
    bodyLimit:16*1024,requestTimeout:15000,trustProxy:options.trustProxy??false,
    ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}});
  await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'data:'],fontSrc:["'self'"],connectSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"],upgradeInsecureRequests:null}},hsts:process.env.NODE_ENV==='production'});
  await app.register(rateLimit,{max:options.rateMax??100,timeWindow:'1 minute'});
  await app.register(swagger,{openapi:{info:{title:'Ангасолка API',version:'1.2.0'},components:{securitySchemes:{telegramWebhook:{type:'apiKey',in:'header',name:'X-Telegram-Bot-Api-Secret-Token'},staffSession:{type:'apiKey',in:'cookie',name:'angasolka_staff'},trackingToken:{type:'http',scheme:'bearer',description:'Secret 64-character hexadecimal order tracking code'}}}}});
  app.addHook('onRequest',async(req,reply)=>{
    if(req.url.startsWith('/api/'))reply.header('Cache-Control','no-store');
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      if(req.headers.origin&&req.headers.origin!==origin)throw new AppError(403,'ORIGIN_REJECTED','Недопустимый источник запроса.');
      if(req.headers['sec-fetch-site']==='cross-site')throw new AppError(403,'ORIGIN_REJECTED','Недопустимый источник запроса.');
    }
  });
  app.setErrorHandler((error,req,reply)=>{
    const status=error instanceof AppError?error.statusCode:(error as {statusCode?:number}).statusCode??500;
    if(status>=500)req.log.error({code:(error as any).code,requestId:req.id},'Request failed');
    reply.code(status).send({error:{code:error instanceof AppError?error.code:status===429?'RATE_LIMITED':status===400?'VALIDATION_ERROR':status===415?'UNSUPPORTED_MEDIA_TYPE':'REQUEST_FAILED',message:error instanceof AppError?error.message:status===429?'Слишком много запросов. Повторите чуть позже.':status<500?'Проверьте формат и поля запроса.':'Сервис временно недоступен. Повторите попытку.',requestId:req.id}});
  });
  app.get('/api/v1/health',async()=>({status:'ok'}));
  app.get('/api/v1/ready',async()=>{await db.query('SELECT version FROM schema_migrations WHERE version=1');return{status:'ready'};});
  app.get('/api/v1/catalog',async()=>catalog(db));
  app.post<{Body:Trip}>('/api/v1/quotes',{schema:{body:tripSchema}},async req=>{const result=await db.transaction(async tx=>{await tx.query('SELECT id FROM pricing_policy WHERE id=1 FOR SHARE');return quote(tx,req.body);});await metric(db,'quote');return result;});
  app.post<{Body:OrderInput}>('/api/v1/orders',{config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{body:orderSchema,headers:{type:'object',required:['idempotency-key'],properties:{'idempotency-key':{type:'string',pattern:'^[a-zA-Z0-9_-]{20,100}$'}}}}},async(req,reply)=>{
    const result=await createOrder(db,req.body,req.headers['idempotency-key'] as string);
    return reply.code(result.replayed?200:201).send(result);
  });
  app.get('/api/v1/orders/status',{config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{security:[{trackingToken:[]}]}},async req=>{
    const match=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization??'');
    if(!match)throw new AppError(401,'UNAUTHORIZED','Укажите секретный код заявки.');
    return trackOrder(db,match[1]);
  });
  if(options.telegram)await registerTelegram(app,db,options.telegram);
  app.get('/api/v1/openapi.json',async()=>app.swagger());
  await registerAdmin(app,db,{origin,sessionKey:options.sessionKey??randomBytes(32),localSetup:options.localSetup??false});
  app.get('/admin',async(_req,reply)=>reply.redirect('/admin/'));
  app.addHook('onResponse',async(req,reply)=>{
    if(req.method==='GET'&&['/','/index.html','/status.html'].includes(req.url.split('?')[0])&&reply.statusCode===200) {
      try{await metric(db,'page_view');}catch{req.log.error('Metric write failed');}
    }
  });
  await app.register(serveStatic,{root:fileURLToPath(new URL('../public',import.meta.url)),dotfiles:'deny'});
  return app;
}

