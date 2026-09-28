import type {TelegramConfig} from './telegram.js';

export function telegramConfig(env:NodeJS.ProcessEnv,origin:string):(TelegramConfig&{token:string})|undefined {
  if(env.TELEGRAM_ENABLED!=='true')return;
  const secret=env.TELEGRAM_WEBHOOK_SECRET??'',token=env.TELEGRAM_BOT_TOKEN??'',staffId=env.TELEGRAM_STAFF_ID??'',id=env.TELEGRAM_ADMIN_USER_ID??'';
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(secret)||!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)||!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)<=0||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(staffId))throw new Error('Telegram requires valid BOT_TOKEN, WEBHOOK_SECRET, ADMIN_USER_ID and STAFF_ID');
  if(!origin.startsWith('https://'))throw new Error('Telegram requires a public HTTPS origin');
  return {secret,token,staffId,adminUserId:Number(id),origin};
}
