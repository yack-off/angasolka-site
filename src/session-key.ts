import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function sessionKey(directory:string,production:boolean) {
  const configured=process.env.ADMIN_SESSION_KEY;
  if(configured){if(!/^[a-f0-9]{64}$/.test(configured))throw new Error('ADMIN_SESSION_KEY must be 64 lowercase hex characters');return Buffer.from(configured,'hex');}
  if(production)throw new Error('Production requires ADMIN_SESSION_KEY');
  await mkdir(directory,{recursive:true});const path=join(directory,'admin-session.key');
  try{await writeFile(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const key=await readFile(path);if(key.length!==32)throw new Error('Invalid session key file');return key;
}
