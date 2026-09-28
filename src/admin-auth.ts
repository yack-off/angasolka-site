import {randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import secureSession from '@fastify/secure-session';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database,Queryable} from './db.js';
import {AppError} from './contracts.js';
import {hash} from './orders.js';
declare module '@fastify/secure-session' {interface SessionData {token:string}}

export type Actor={id:string;username:string;role:'owner'|'manager'|'viewer'};
export const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
export const str=(maxLength=200,minLength=1)=>({type:'string',minLength,maxLength});
export const int=(maximum=1000000,minimum=0)=>({type:'integer',minimum,maximum});
export const version=int(2147483647,1);
export const credentials=object({username:{...str(40,3),pattern:'^[a-zA-Z0-9_.-]+$'},password:str(128,12)});
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(e,v)=>e?reject(e):resolve(v)));
export async function passwordHash(password:string) {const salt=randomBytes(16).toString('hex');return salt+':'+(await derive(password,salt)).toString('hex');}
export async function verifyPassword(password:string,stored:string) {const [salt,key]=stored.split(':');return timingSafeEqual(await derive(password,salt),Buffer.from(key,'hex'));}
export async function audit(tx:Queryable,actor:Actor,action:string,entity:string,details:Record<string,unknown>={}) {
  await tx.query('INSERT INTO admin_audit(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor.id,action,entity,JSON.stringify(details)]);
}
export async function authorize(tx:Queryable,actor:Actor,write=false,owner=false) {
  const user=(await tx.query('SELECT id,username,role FROM staff WHERE id=$1 AND active=true FOR SHARE',[actor.id])).rows[0] as Actor|undefined;
  if(!user)throw new AppError(401,'UNAUTHORIZED','Войдите в кабинет.');
  if((write&&user.role==='viewer')||(owner&&user.role!=='owner'))throw new AppError(403,'FORBIDDEN','Недостаточно прав для этого действия.');
  return user;
}
export async function registerAuth(app:FastifyInstance,db:Database,options:{origin:string;sessionKey:Buffer;localSetup:boolean}) {
  await app.register(secureSession,{key:options.sessionKey,cookieName:'angasolka_staff',expiry:28800,cookie:{path:'/api/v1/admin',httpOnly:true,sameSite:'strict',secure:options.origin.startsWith('https:'),maxAge:28800}});
  const cache=new WeakMap<FastifyRequest,Actor>();
  const current=async(req:FastifyRequest):Promise<Actor>=>{
    const cached=cache.get(req);if(cached)return cached;
    const token=req.session.get('token');
    if(typeof token!=='string')throw new AppError(401,'UNAUTHORIZED','Войдите в кабинет.');
    const actor=(await db.query('SELECT u.id,u.username,u.role FROM staff_sessions s JOIN staff u ON u.id=s.staff_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[hash(token)])).rows[0];
    if(!actor)throw new AppError(401,'UNAUTHORIZED','Сессия истекла. Войдите снова.');
    cache.set(req,actor as Actor);return actor as Actor;
  };
  app.addHook('onRequest',async req=>{
    if(req.url.startsWith('/api/v1/admin')&&['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.headers.origin!==options.origin)throw new AppError(403,'ORIGIN_REJECTED','Обновите страницу и повторите действие.');
  });
  const setupAllowed=(req:FastifyRequest)=>options.localSetup&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip);
  app.get('/api/v1/admin/session',{schema:{tags:['Admin access'],summary:'Сотрудник и доступность локальной первичной настройки'}},async req=>{
    const empty=!(await db.query('SELECT id FROM staff LIMIT 1')).rows.length;
    if(empty)return {user:null,setup:setupAllowed(req)};
    try{return {user:await current(req),setup:false};}catch(e){if(e instanceof AppError&&e.statusCode===401)return {user:null,setup:false};throw e;}
  });
  const login=async(req:FastifyRequest,actor:Actor)=>{
    const token=randomBytes(32).toString('hex');
    await db.transaction(async tx=>{
      await authorize(tx,actor);
      await tx.query('DELETE FROM staff_sessions WHERE expires_at<=now()');
      await tx.query("INSERT INTO staff_sessions(token_hash,staff_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",[hash(token),actor.id]);
      await audit(tx,actor,'session.login',actor.id);
    });
    req.session.regenerate();req.session.set('token',token);return {user:actor};
  };
  app.post<{Body:{username:string;password:string}}>('/api/v1/admin/setup',{config:{rateLimit:{max:5,timeWindow:'15 minutes'}},schema:{tags:['Admin access'],summary:'Первый владелец, только loopback в development',body:credentials}},async req=>{
    if(!setupAllowed(req))throw new AppError(403,'SETUP_DISABLED','Создайте владельца командой pnpm admin:create на сервере.');
    const encoded=await passwordHash(req.body.password);
    const actor=await db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(418002)');
      if((await tx.query('SELECT id FROM staff LIMIT 1')).rows.length)throw new AppError(409,'SETUP_COMPLETE','Владелец уже создан. Выполните вход.');
      const user={id:randomUUID(),username:req.body.username.toLowerCase(),role:'owner' as const};
      await tx.query('INSERT INTO staff(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[user.id,user.username,encoded,user.role]);
      await audit(tx,user,'staff.bootstrap',user.id);return user;
    });return login(req,actor);
  });
  // Equal-cost verification for unknown usernames. The value is never an account credential.
  const dummy=await passwordHash(randomBytes(32).toString('hex'));
  app.post<{Body:{username:string;password:string}}>('/api/v1/admin/login',{config:{rateLimit:{max:10,timeWindow:'15 minutes'}},schema:{tags:['Admin access'],summary:'Вход по паролю, HttpOnly cookie на 8 часов',body:credentials}},async req=>{
    const actor=await db.transaction(async tx=>{
      const u=(await tx.query('SELECT * FROM staff WHERE username=$1 FOR UPDATE',[req.body.username.toLowerCase()])).rows[0];
      const valid=await verifyPassword(req.body.password,u?.password_hash??dummy);
      if(!u)return null;
      if(!valid||!u.active||(u.locked_until&&new Date(u.locked_until)>new Date())) {
        if(!u.locked_until||new Date(u.locked_until)<=new Date())await tx.query("UPDATE staff SET failed_attempts=CASE WHEN failed_attempts>=4 THEN 0 ELSE failed_attempts+1 END,locked_until=CASE WHEN failed_attempts>=4 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=$1",[u.id]);
        return null;
      }
      await tx.query('UPDATE staff SET failed_attempts=0,locked_until=NULL WHERE id=$1',[u.id]);
      return {id:u.id,username:u.username,role:u.role} as Actor;
    });
    if(!actor)throw new AppError(401,'LOGIN_FAILED','Не удалось войти. Проверьте данные или повторите через 15 минут.');
    return login(req,actor);
  });
  app.post('/api/v1/admin/logout',{schema:{tags:['Admin access'],summary:'Отозвать текущую сессию'}},async req=>{
    const token=req.session.get('token');if(typeof token==='string')await db.query('DELETE FROM staff_sessions WHERE token_hash=$1',[hash(token)]);
    req.session.delete();return {ok:true};
  });
  return current;
}
