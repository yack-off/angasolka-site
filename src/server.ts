import {telegramConfig} from './telegram-config.js';
import {startTelegramWorker,telegramSender} from './telegram-worker.js';
import {config,production} from './config.js';
import {connectDatabase,migrate} from './db.js';
import {buildApp} from './app.js';
import {sessionKey} from './session-key.js';
import {loadTls} from './transport.js';
const https=config.certFile?await loadTls(config.certFile,config.keyFile!,config.origin):undefined;
const db=await connectDatabase(config.databaseUrl,config.dataDir);
try {
  if(!production)await migrate(db);
  await db.query('SELECT version FROM schema_migrations WHERE version=1');
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=2')).rows.length)throw new Error('Run pnpm db:migrate before starting the server');
  const telegram=telegramConfig(process.env,config.origin);
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=4')).rows.length)throw new Error('Run pnpm db:migrate before starting the server');
  const app=await buildApp(db,{telegram,origin:config.origin,https,trustProxy:config.trustProxy,logger:true,sessionKey:await sessionKey(config.dataDir,production),localSetup:!production&&!config.trustProxy&&['127.0.0.1','::1'].includes(config.host)});
  let stopTelegram:undefined|(()=>Promise<void>);
  let closing=false;
  const shutdown=async()=>{if(closing)return;closing=true;await stopTelegram?.();await app.close();await db.close();};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  await app.listen({host:config.host,port:config.port});
  if(telegram)stopTelegram=startTelegramWorker(db,telegram,telegramSender(telegram.token),()=>app.log.error('Telegram worker failed; delivery remains queued'));
} catch(error) {await db.close();throw error;}
