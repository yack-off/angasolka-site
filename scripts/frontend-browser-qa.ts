// Test-only browser harness. Never used by production startup.
// Data, credentials and request bodies live only in memory. Controls are local files.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {connectDatabase,migrate} from '../src/db.js';
import {buildApp} from '../src/app.js';

const root=new URL('../test-results/frontend-qa/',import.meta.url);
await mkdir(root,{recursive:true});
const origin='http://127.0.0.1:4183';
const db=await connectDatabase(undefined,'memory://');await migrate(db);
const app=await buildApp(db,{origin,localSetup:true,rateMax:10000});await app.ready();
const setup=await app.inject({method:'POST',url:'/api/v1/admin/setup',headers:{origin},payload:{username:'frontend-qa',password:randomBytes(24).toString('hex')}});
if(setup.statusCode!==200)throw Error('Test owner setup failed');
const cookie=String(setup.headers['set-cookie']).split(';')[0];
async function admin(method:any,path:string,payload?:any){const r=await app.inject({method,url:'/api/v1/admin'+path,headers:{origin,cookie},...(payload?{payload}:{})});if(r.statusCode>=400)throw Error('Admin action '+r.statusCode+' '+r.json().error?.code);return r.json();}
let fault:any=null,lastCommand='',busy=false,previousOrder:{key:unknown;body:string;id:string}|null=null;
const events:any[]=[];let persistChain=Promise.resolve();
const state:any={ready:true,origin,commandId:'',commandResult:null};
function persist(){persistChain=persistChain.catch(()=>{}).then(async()=>{state.orders=(await db.query('SELECT status,total_minor FROM orders ORDER BY created_at')).rows;state.events=events.slice(-40);state.policy=(await db.query('SELECT version,discount_nights,discount_percent FROM pricing_policy WHERE id=1')).rows[0];await writeFile(new URL('state.json',root),JSON.stringify(state,null,2));});return persistChain;}
const server=createServer(async(req,res)=>{
 try{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString();const url=req.url??'/';
  const f=fault&&url===fault.path&&fault.remaining!==0?{...fault}:null;if(f&&fault.remaining>0)fault.remaining--;
  const e:any={path:url.split('?')[0],mode:f?.mode??'normal'};
  if(url==='/api/v1/orders'){e.sameKeyAsPrevious=previousOrder?.key===req.headers['idempotency-key'];e.sameBodyAsPrevious=previousOrder?.body===body;}
  if(url.startsWith('/api/v1/orders/status')){e.authorizationPresent=!!req.headers.authorization;e.queryPresent=url.includes('?');}
  if(f?.mode==='drop'){events.push({...e,status:'network-error'});await persist();res.destroy();return;}
  if(f?.mode==='timeout'){events.push({...e,status:'delayed-before'});await persist();setTimeout(()=>res.destroy(),17000);return;}
  if(f?.mode==='500'||f?.mode==='429'){res.writeHead(Number(f.mode),{'content-type':'application/json'});res.end(JSON.stringify({error:{code:f.mode==='429'?'RATE_LIMITED':'REQUEST_FAILED',message:f.mode==='429'?'Слишком много запросов. Повторите чуть позже.':'Сервис временно недоступен. Повторите попытку.'}}));events.push({...e,status:Number(f.mode)});await persist();return;}
  const r=await app.inject({method:req.method as any,url,headers:req.headers,...(body?{payload:body}:{})});
  e.status=r.statusCode;
  if(url==='/api/v1/orders'&&r.statusCode<300){const result=r.json();e.replayed=result.replayed;e.sameOrderAsPrevious=previousOrder?.id===result.order.id;previousOrder={key:req.headers['idempotency-key'],body,id:result.order.id};e.total=result.order.quote.totalMinor;}
  if(url==='/api/v1/quotes'&&r.statusCode===200){const q=r.json();e.total=q.totalMinor;e.discount=q.discountMinor;}
  if(url.startsWith('/api/'))events.push(e);await persist();
  if(f?.mode==='drop-after'){res.destroy();return;}
  const send=()=>{if(res.destroyed)return;res.writeHead(r.statusCode,r.headers as any);res.end(r.rawPayload);};
  if(f?.mode==='delay-after'||f?.mode==='timeout-after')setTimeout(send,f.mode==='timeout-after'?17000:3000);else send();
 }catch{res.writeHead(500);res.end('QA harness failure');}
});
await new Promise<void>(resolve=>server.listen(4183,'127.0.0.1',resolve));
async function close(){clearInterval(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await persistChain;await app.close();await db.close();}
const timer=setInterval(async()=>{
 if(busy)return;busy=true;
 try{const c=JSON.parse(await readFile(new URL('command.json',root),'utf8'));if(c.id===lastCommand)return;lastCommand=c.id;
  try{
   if(c.action==='fault')fault=c.fault;
   else if(c.action==='catalog'){const cat=await admin('GET','/catalog');const product=cat.products.find((p:any)=>p.id===c.product);await admin('PUT','/catalog',{...product,...c.changes,version:cat.policy.version});}
   else if(c.action==='policy'){const cat=await admin('GET','/catalog');await admin('PUT','/policy',{version:cat.policy.version,demo:cat.policy.demo,discount_nights:cat.policy.discount_nights,discount_percent:cat.policy.discount_percent,...c.changes});}
   else if(c.action==='content'){const b=(await admin('GET','/content')).blocks.find((b:any)=>b.id===c.block);await admin('PUT','/content/'+c.block,{title:b.title,enabled:c.enabled??b.enabled,sort_order:b.sort_order,version:b.version,fields:b.fields.map((f:any)=>f.key===c.field?{...f,value:c.value}:f)});}
   else if(c.action==='contacted'){const o=(await db.query('SELECT id,version FROM orders ORDER BY created_at DESC LIMIT 1')).rows[0];await admin('PATCH','/orders/'+o.id,{version:o.version,status:'contacted',comment:''});}
   else if(c.action!=='snapshot'&&c.action!=='stop')throw Error('Unknown command');
   state.commandResult={ok:true};
  }catch(error){state.commandResult={ok:false,error:String(error)};}
  state.commandId=c.id;await persist();if(c.action==='stop')await close();
 }catch{}finally{busy=false;}
},100);
await persist();console.log('Frontend QA ready on '+origin+'; memory DB; integrations disabled.');
process.once('SIGINT',close);process.once('SIGTERM',close);
