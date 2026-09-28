import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {config} from './config.js';
import {connectDatabase} from './db.js';
import {passwordHash,audit} from './admin-auth.js';
if(!process.stdin.isTTY)throw new Error('Use an interactive terminal. Do not pass passwords as command arguments.');
let muted=false;
const output=new Writable({write(chunk,_encoding,callback){if(!muted)process.stdout.write(chunk);callback();}});
const rl=createInterface({input:process.stdin,output,terminal:true});
let db;
try {
  const username=(await rl.question('Owner login (3-40 Latin letters, numbers, ._-): ')).trim().toLowerCase();
  process.stdout.write('Password (12-128 characters, hidden): ');muted=true;
  const password=await rl.question('');muted=false;process.stdout.write('\n');
  process.stdout.write('Repeat password: ');muted=true;const repeat=await rl.question('');muted=false;process.stdout.write('\n');
  if(!/^[a-z0-9_.-]{3,40}$/.test(username)||password.length<12||password.length>128||password!==repeat)throw new Error('Invalid login, password length, or confirmation.');
  const encoded=await passwordHash(password);db=await connectDatabase(config.databaseUrl,config.dataDir);
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(418002)');
    if((await tx.query('SELECT id FROM staff LIMIT 1')).rows.length)throw new Error('Staff already exists. Use the owner interface to manage access.');
    const actor={id:randomUUID(),username,role:'owner' as const};
    await tx.query("INSERT INTO staff(id,username,password_hash,role) VALUES($1,$2,$3,'owner')",[actor.id,username,encoded]);
    await audit(tx,actor,'staff.bootstrap',actor.id);
  });
  process.stdout.write('Owner created. Open /admin/ to sign in.\n');
}finally{rl.close();await db?.close();}
