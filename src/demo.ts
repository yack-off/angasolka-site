import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {connectDatabase,migrate,type Database} from './db.js';
import {buildApp} from './app.js';
import {passwordHash,audit} from './admin-auth.js';
import {sessionKey} from './session-key.js';
import {telegramConfig} from './telegram-config.js';
import {startTelegramWorker,telegramSender} from './telegram-worker.js';
import {demoProxy} from './demo-proxy.js';

if(existsSync('.env'))process.loadEnvFile('.env');
if(process.env.NODE_ENV==='production'||process.env.DATABASE_URL)throw new Error('Demo launcher is for the local test database only. Use the production deployment process for external databases.');
// Public testing must never open the user's local working database or existing contacts.
const directory=resolve('data/demo/postgres');
const runtime=resolve('data/demo');
const statePath=resolve(runtime,'running.json');
const stopPath=resolve(runtime,'stop');
const port=4185,proxyPort=4190;
let origin:string|undefined,db:Database|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
let tunnel:ChildProcess|undefined,stopWorker:(()=>Promise<void>)|undefined;
let closing=false,ownsState=false;
const proxy=demoProxy(port,()=>origin);
const close=async()=>{
  if(closing)return;closing=true;origin=undefined;
  clearInterval(stopTimer);
  tunnel?.kill();
  await stopWorker?.();
  if(proxy.listening){proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));}
  await app?.close();await db?.close();
  if(ownsState)await unlink(statePath).catch(()=>{});
};
const stopTimer=setInterval(()=>{if(existsSync(stopPath))void close();},1000);
stopTimer.unref();
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
async function assertFree(p:number) {
  const server=createServer();
  await new Promise<void>((ok,no)=>{server.once('error',()=>no(new Error(`Port ${p} is busy. Stop the previous local site first.`)));server.listen(p,'127.0.0.1',()=>server.close(()=>ok()));});
}
try {
  await mkdir(runtime,{recursive:true});
  if(existsSync(statePath)){
    const saved=JSON.parse(await readFile(statePath,'utf8')) as {pid:number};
    let alive=false;try{process.kill(saved.pid,0);alive=true;}catch{}
    if(alive)throw new Error('A demo is already running. Use Stop-Demo.ps1 first.');
    await unlink(statePath);
  }
  await writeFile(statePath,JSON.stringify({pid:process.pid,status:'starting'}),{flag:'wx'});ownsState=true;
  await unlink(stopPath).catch(()=>{});
  await assertFree(port);await assertFree(proxyPort);
  db=await connectDatabase(undefined,directory);await migrate(db);
  const accessPath=resolve(runtime,'admin-access.txt');
  let staffId:string;
  if(existsSync(accessPath)){
    const access=JSON.parse(await readFile(accessPath,'utf8')) as {staffId:string};staffId=access.staffId;
    if(!(await db.query("SELECT id FROM staff WHERE id=$1 AND active=true AND role='owner'",[staffId])).rows.length)throw new Error('Demo account was changed. Check the local admin access file.');
  }else{
    staffId=randomUUID();const username='demo-'+randomBytes(4).toString('hex'),password=randomBytes(24).toString('base64url');
    const encoded=await passwordHash(password);
    await db.transaction(async tx=>{
      const actor={id:staffId,username,role:'owner' as const};
      await tx.query("INSERT INTO staff(id,username,password_hash,role) VALUES($1,$2,$3,'owner')",[staffId,username,encoded]);
      await audit(tx,actor,'staff.bootstrap.demo',staffId);
    });
    await writeFile(accessPath,JSON.stringify({username,password,staffId},null,2),{flag:'wx',mode:0o600});
  }
  const executable=resolve('data/tools/cloudflared.exe');
  if(!existsSync(executable))throw new Error('Run Start-Demo.ps1 to install cloudflared.');
  await new Promise<void>((ok,no)=>{proxy.once('error',no);proxy.listen(proxyPort,'127.0.0.1',ok);});
  tunnel=spawn(executable,['tunnel','--no-autoupdate','--protocol','http2','--url',`http://127.0.0.1:${proxyPort}`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const url=await new Promise<string>((ok,no)=>{
    const timer=setTimeout(()=>no(new Error('Tunnel did not return an HTTPS URL within 60 seconds.')),60000);
    let buffer='';
    const consume=(data:Buffer)=>{buffer=(buffer+data.toString()).slice(-12000);const match=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){clearTimeout(timer);ok(match[0]);}};
    tunnel!.stdout!.on('data',consume);tunnel!.stderr!.on('data',consume);
    tunnel!.once('error',()=>{clearTimeout(timer);no(new Error('Could not start cloudflared'));});
    tunnel!.once('exit',()=>{clearTimeout(timer);no(new Error('Tunnel exited during startup'));void close();});
  });
  const telegram=telegramConfig({...process.env,TELEGRAM_STAFF_ID:process.env.TELEGRAM_STAFF_ID??staffId},url);
  if(telegram&&!(await db.query("SELECT id FROM staff WHERE id=$1 AND active=true AND role IN ('owner','manager')",[telegram.staffId])).rows.length)throw new Error('Configured Telegram staff account is not active.');
  app=await buildApp(db,{origin:url,trustProxy:'loopback',localSetup:false,telegram,sessionKey:await sessionKey(directory,false)});
  await app.listen({host:'127.0.0.1',port});origin=url;
  await writeFile(statePath,JSON.stringify({pid:process.pid,url,admin:url+'/admin/',telegram:telegram?'connecting':'not-configured',startedAt:new Date().toISOString()},null,2));
  await writeFile(resolve(runtime,'links.txt'),`Сайт: ${url}\nАдминка и CRM: ${url}/admin/\nДоступ к админке: ${accessPath}\nОстановить: Stop-Demo.ps1\n`);
  console.log(`Сайт: ${url}\nАдминка и CRM: ${url}/admin/\nДоступ сохранён локально: data/demo/admin-access.txt`);
  if(telegram){
    let ready=false;
    const readinessDeadline=Date.now()+180000;
    while(Date.now()<readinessDeadline&&!closing){
      try{const r=await fetch(url+'/api/v1/ready',{signal:AbortSignal.timeout(5000)});if(r.ok){ready=true;break;}}catch{}
      await delay(2000);
    }
    if(!ready)throw new Error('Public HTTPS did not become ready; Telegram webhook has not been changed.');
    try{
      const result=await fetch(`https://api.telegram.org/bot${telegram.token}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({url:url+'/api/v1/telegram/webhook',secret_token:telegram.secret,allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false})});
      if(!result.ok||!(await result.json() as {ok:boolean}).ok)throw new Error();
    }catch{throw new Error('Telegram connection failed. Check local credentials; no token was logged.');}
    stopWorker=startTelegramWorker(db,telegram,telegramSender(telegram.token),()=>console.error('Telegram delivery remains queued.'));
    await writeFile(statePath,JSON.stringify({pid:process.pid,url,admin:url+'/admin/',telegram:'connected',startedAt:new Date().toISOString()},null,2));
    console.log('Telegram webhook подключён. Отправьте боту /start.');
  }else console.log('Telegram пока выключен. Заполните настройки через Setup-Telegram.ps1 и перезапустите демо.');
}catch(error){console.error(error instanceof Error?error.message:'Demo startup failed');await close();process.exitCode=1;}
