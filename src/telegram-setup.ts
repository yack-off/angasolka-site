import {config} from './config.js';
import {telegramConfig} from './telegram-config.js';

// Explicit operator command. Starting the local app never registers or replaces a webhook.
try {
  const c=telegramConfig(process.env,config.origin);
  if(!c)throw new Error('Enable Telegram in server configuration first');
  const response=await fetch(`https://api.telegram.org/bot${c.token}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({url:c.origin+'/api/v1/telegram/webhook',secret_token:c.secret,allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false})});
  const result=await response.json() as {ok?:boolean};
  if(!response.ok||!result.ok)throw new Error('Registration failed');
  console.log('Telegram webhook registered. Open the bot and send /start.');
} catch {
  console.error('Telegram webhook registration failed. Check server configuration, HTTPS and bot credentials.');
  process.exitCode=1;
}
