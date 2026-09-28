import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generate} from 'selfsigned';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {get,request,type RequestOptions} from 'node:https';
import {randomBytes} from 'node:crypto';
import {transportConfig,loadTls} from '../src/transport.js';
import {buildApp} from '../src/app.js';
import {connectDatabase,migrate,type Database} from '../src/db.js';

let directory:string,certFile:string,keyFile:string,root:string,app:Awaited<ReturnType<typeof buildApp>>,db:Database,port:number;
function call(path:string,options:RequestOptions={},body?:object):Promise<{status:number;headers:any;body:any}>{
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,servername:'localhost',ca:root,...options},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(text)}));
    });req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('TLS test timeout')));req.end(body?JSON.stringify(body):undefined);
  });
}
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'angasolka-tls-'));certFile=join(directory,'fullchain.pem');keyFile=join(directory,'private.key');
  const ca=await generate([{name:'commonName',value:'Temporary Test CA'}],{algorithm:'sha256',extensions:[{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]});
  root=ca.cert;
  const leaf=await generate([{name:'commonName',value:'localhost'}],{algorithm:'sha256',ca:{key:ca.private,cert:ca.cert}});
  await writeFile(certFile,leaf.cert);await writeFile(keyFile,leaf.private);
  db=await connectDatabase(undefined,'memory://');await migrate(db);
  app=await buildApp(db,{https:await loadTls(certFile,keyFile,'https://localhost'),origin:'https://localhost',localSetup:true});
  await app.listen({host:'127.0.0.1',port:0});port=(app.server.address() as {port:number}).port;
});
after(async()=>{await app?.close();await db?.close();if(directory)await rm(directory,{recursive:true,force:true});});
test('TLS handshake requires a trusted CA and correct hostname',async()=>{
  assert.equal((await call('/api/v1/health')).status,200);
  await assert.rejects(call('/api/v1/health',{ca:[]}),/certificate|issuer|verify/i);
  await assert.rejects(call('/api/v1/health',{servername:'wrong.example'}),/hostname|altnames/i);
  assert.equal((await call('/api/v1/health',{minVersion:'TLSv1.2',maxVersion:'TLSv1.2'})).status,200);
  assert.equal((await call('/api/v1/health',{minVersion:'TLSv1.3',maxVersion:'TLSv1.3'})).status,200);
});
test('TLS loader rejects key mismatch, wrong SAN and expired certificate before startup',async()=>{
  await assert.rejects(loadTls(certFile,keyFile,'https://wrong.example'),/SAN/);
  await assert.rejects(loadTls(certFile,keyFile,'https://localhost',Date.now()+800*86400000),/expired/);
  const other=await generate([{name:'commonName',value:'other.example'}],{algorithm:'sha256'});
  const otherKey=join(directory,'other.key');await writeFile(otherKey,other.private);
  await assert.rejects(loadTls(certFile,otherKey,'https://localhost'),/private key/);
  const bundle=join(directory,'bundle.pem');const {readFile}=await import('node:fs/promises');
  await writeFile(bundle,(await readFile(certFile,'utf8'))+'\n'+root);
  await loadTls(bundle,keyFile,'https://localhost');
  await writeFile(bundle,(await readFile(certFile,'utf8'))+'\n'+other.cert);
  await assert.rejects(loadTls(bundle,keyFile,'https://localhost'),/chain/);
});
test('staff session works over HTTPS with Secure cookie and strict Origin checks',async()=>{
  const headers={origin:'https://localhost','content-type':'application/json'};
  const response=await call('/api/v1/admin/setup',{method:'POST',headers},{username:'tls-owner',password:randomBytes(24).toString('hex')});
  assert.equal(response.status,200);
  const cookie=response.headers['set-cookie'][0];assert.match(cookie,/; Secure/i);assert.match(cookie,/HttpOnly/i);
  assert.equal((await call('/api/v1/admin/session',{headers:{cookie:cookie.split(';')[0]}})).status,200);
  assert.equal((await call('/api/v1/quotes',{method:'POST',headers:{...headers,origin:'https://wrong.example'}},{})).status,403);
});
test('transport config fails closed; local HTTP stays available; proxy binding is restricted',()=>{
  assert.equal(transportConfig({}).trustProxy,false);
  for(const env of [{TLS_CERT_FILE:'cert'}, {PUBLIC_ORIGIN:'https://example.com/'},{PUBLIC_ORIGIN:'https://example.com',TRUST_PROXY:'true'},{NODE_ENV:'production',PUBLIC_ORIGIN:'https://example.com'},{PUBLIC_ORIGIN:'https://example.com',HOST:'0.0.0.0',TRUST_PROXY:'loopback'}])assert.throws(()=>transportConfig(env));
  assert.equal(transportConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'https://example.com',TRUST_PROXY:'loopback'}).trustProxy,'loopback');
});
test('forwarded client address is accepted only from explicitly trusted loopback proxy',async()=>{
  for(const trustProxy of [false,'loopback'] as const){
    const proxyApp=await buildApp(db,{origin:'https://example.com',trustProxy});
    proxyApp.get('/test-transport',req=>({ip:req.ip,protocol:req.protocol}));
    try{
      const headers={'x-forwarded-for':'192.0.2.40','x-forwarded-proto':'https'};
      const local=(await proxyApp.inject({url:'/test-transport',remoteAddress:'127.0.0.1',headers})).json();
      assert.equal(local.ip,trustProxy?'192.0.2.40':'127.0.0.1');assert.equal(local.protocol,trustProxy?'https':'http');
      const external=(await proxyApp.inject({url:'/test-transport',remoteAddress:'198.51.100.7',headers})).json();
      assert.equal(external.ip,'198.51.100.7');assert.equal(external.protocol,'http');
    }finally{await proxyApp.close();}
  }
});
