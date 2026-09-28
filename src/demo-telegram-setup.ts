import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile,writeFile,rename} from 'node:fs/promises';

// Runs only in the user's interactive terminal. Never print credentials or API errors.
if(!process.stdin.isTTY)throw new Error('Open Setup-Telegram.ps1 in an interactive terminal.');
let muted=false;
const output=new Writable({write(chunk,_encoding,callback){if(!muted)process.stdout.write(chunk);callback();}});
const rl=createInterface({input:process.stdin,output,terminal:true});
const api=async<T>(token:string,method:string,body:Record<string,unknown>={}):Promise<T>=>{
  try{
    const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
    const data=await response.json() as {ok?:boolean;result:T};
    if(!response.ok||!data.ok)throw new Error();return data.result;
  }catch{throw new Error('Telegram недоступен или токен неверен. Токен не записан в журнал.');}
};
try{
  if(existsSync('data/demo/running.json')){
    const state=JSON.parse(await readFile('data/demo/running.json','utf8')) as {telegram:string};
    if(state.telegram==='connected')throw new Error('Сначала остановите демо: бот уже подключён.');
  }
  const previous=existsSync('.env')?await readFile('.env','utf8'):'';
  if(existsSync('.env'))process.loadEnvFile('.env');
  let token=process.env.TELEGRAM_BOT_TOKEN??'';
  if(!token){process.stdout.write('Вставьте токен BotFather (ввод скрыт), затем Enter: ');muted=true;token=(await rl.question('')).trim();muted=false;process.stdout.write('\n');}
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))throw new Error('Неверный формат токена.');
  const me=await api<{username:string}>(token,'getMe');
  const info=await api<{url:string}>(token,'getWebhookInfo');
  if(info.url){
    const answer=await rl.question('У бота уже есть webhook. Переключить его на этот тестовый проект? Введите ДА: ');
    if(answer.trim()!=='ДА')throw new Error('Настройка отменена, прежний webhook сохранён.');
    await api(token,'deleteWebhook',{drop_pending_updates:false});
  }
  const challenge=randomBytes(12).toString('hex');
  console.log(`Откройте https://t.me/${me.username} и отправьте боту сообщение:\n/connect ${challenge}\nОжидаю подтверждение из вашего личного Telegram (до 5 минут)…`);
  const until=Date.now()+5*60*1000;let offset=0,userId:number|undefined;
  while(Date.now()<until&&!userId){
    const updates=await api<Array<{update_id:number;message?:{text?:string;from?:{id:number;is_bot?:boolean};chat:{id:number;type:string}}}>>(token,'getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});
    for(const update of updates){
      offset=Math.max(offset,update.update_id+1);const message=update.message;
      if(message?.chat.type==='private'&&message.from&&!message.from.is_bot&&message.chat.id===message.from.id&&message.text===`/connect ${challenge}`)userId=message.from.id;
    }
  }
  if(!userId)throw new Error('Подтверждение не получено. Запустите настройку ещё раз.');
  await api(token,'getUpdates',{offset,timeout:0});
  const values:Record<string,string>={TELEGRAM_BOT_TOKEN:token,TELEGRAM_WEBHOOK_SECRET:randomBytes(32).toString('hex'),TELEGRAM_ADMIN_USER_ID:String(userId),TELEGRAM_ENABLED:'true'};
  let contents=previous;
  for(const [key,value] of Object.entries(values)){
    const pattern=new RegExp(`^${key}=.*$`,'gm');
    contents=pattern.test(contents)?contents.replace(pattern,()=>`${key}=${value}`):contents.replace(/\s*$/,'')+`\n${key}=${value}\n`;
  }
  await writeFile('.env.setup.tmp',contents,{mode:0o600});await rename('.env.setup.tmp','.env');
  console.log('Токен сохранён только в .env. Telegram привязан. Остановите демо и запустите снова: Stop-Demo.ps1, затем Start-Demo.ps1.');
}catch(error){muted=false;console.error(error instanceof Error?error.message:'Настройка не завершена.');process.exitCode=1;}
finally{rl.close();}
