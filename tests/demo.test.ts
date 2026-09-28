import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tunnelHeaders} from '../src/demo-proxy.js';
import {connectDatabase,migrate} from '../src/db.js';
import {buildApp} from '../src/app.js';

test('tunnel replaces forged forwarding headers and rejects wrong host, HTTP and missing client identity',()=>{
  const origin='https://preview.trycloudflare.com';
  const headers={host:'preview.trycloudflare.com','cf-connecting-ip':'203.0.113.10','x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1','x-forwarded-host':'evil.invalid',forwarded:'for=127.0.0.1'};
  const result=tunnelHeaders(headers,origin)!;
  assert.equal(result['x-forwarded-for'],'203.0.113.10');assert.equal(result.forwarded,undefined);
  assert.equal(result['x-forwarded-host'],'preview.trycloudflare.com');
  assert.equal(tunnelHeaders({...headers,host:'evil.invalid'},origin),null);
  assert.equal(tunnelHeaders({...headers,'x-forwarded-proto':'http'},origin),null);
  assert.equal(tunnelHeaders({...headers,'cf-connecting-ip':undefined},origin),null);
});

test('HTTPS preview disables public owner creation and enforces admin origin and authorization',async()=>{
  const db=await connectDatabase(undefined,'memory://');await migrate(db);
  const app=await buildApp(db,{origin:'https://preview.trycloudflare.com',trustProxy:'loopback',localSetup:false});
  try{
    const session=await app.inject({url:'/api/v1/admin/session'});assert.equal(session.json().setup,false);
    const setup=await app.inject({method:'POST',url:'/api/v1/admin/setup',headers:{origin:'https://preview.trycloudflare.com'},payload:{username:'visitor',password:'a-long-test-password'}});
    assert.equal(setup.statusCode,403);
    assert.equal((await app.inject({url:'/api/v1/admin/orders'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/logout',headers:{origin:'https://other.invalid'}})).statusCode,403);
  }finally{await app.close();await db.close();}
});
