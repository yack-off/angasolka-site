import {readFile} from 'node:fs/promises';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {createSecureContext,type SecureContextOptions} from 'node:tls';
import {isIP} from 'node:net';

export function transportConfig(env:NodeJS.ProcessEnv) {
  const origin=env.PUBLIC_ORIGIN??'http://127.0.0.1:4180';
  const parsed=new URL(origin);
  if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin)throw new Error('PUBLIC_ORIGIN must be an exact http(s) origin without path, trailing slash or credentials');
  const certFile=env.TLS_CERT_FILE,keyFile=env.TLS_KEY_FILE;
  if(Boolean(certFile)!==Boolean(keyFile))throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be configured together');
  if(certFile&&parsed.protocol!=='https:')throw new Error('TLS requires an HTTPS PUBLIC_ORIGIN');
  const proxyMode=env.TRUST_PROXY??'none';
  if(!['none','loopback'].includes(proxyMode))throw new Error('TRUST_PROXY must be none or loopback');
  if(certFile&&proxyMode!=='none')throw new Error('Choose direct TLS or a loopback TLS proxy');
  const host=env.HOST??'127.0.0.1';
  if(proxyMode==='loopback'&&(!['127.0.0.1','::1'].includes(host)||parsed.protocol!=='https:'))throw new Error('Loopback proxy requires loopback HOST and an HTTPS PUBLIC_ORIGIN');
  if(env.NODE_ENV==='production'&&(!certFile&&proxyMode==='none'))throw new Error('Production requires direct TLS or TRUST_PROXY=loopback behind an HTTPS proxy');
  if(env.NODE_ENV==='production'&&parsed.protocol!=='https:')throw new Error('Production requires an HTTPS PUBLIC_ORIGIN');
  return {origin,host,certFile,keyFile,trustProxy:proxyMode==='loopback'?'loopback' as const:false as const};
}

export async function loadTls(certFile:string,keyFile:string,origin:string,now=Date.now()):Promise<SecureContextOptions & {cert:string;key:string}> {
  const [cert,key]=await Promise.all([readFile(certFile,'utf8'),readFile(keyFile,'utf8')]);
  const blocks=cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if(!blocks?.length)throw new Error('TLS_CERT_FILE must contain a PEM certificate followed by its intermediate certificates');
  const chain=blocks.map(pem=>new X509Certificate(pem));
  for(const item of chain)if(now<Date.parse(item.validFrom)||now>=Date.parse(item.validTo))throw new Error('TLS certificate chain contains an expired or not-yet-valid certificate');
  const leaf=chain[0];
  if(leaf.ca)throw new Error('First TLS certificate must be a server certificate, not a CA');
  const hostname=new URL(origin).hostname.replace(/^\[|\]$/g,'');
  if(!(isIP(hostname)?leaf.checkIP(hostname):leaf.checkHost(hostname,{subject:'never'})))throw new Error('TLS certificate SAN does not match PUBLIC_ORIGIN');
  if(!leaf.checkPrivateKey(createPrivateKey(key)))throw new Error('TLS private key does not match the server certificate');
  for(let i=1;i<chain.length;i++)if(!chain[i].ca||!chain[i-1].checkIssued(chain[i])||!chain[i-1].verify(chain[i].publicKey))throw new Error('TLS intermediate chain is invalid or out of order');
  const options={cert,key,minVersion:'TLSv1.2' as const};
  createSecureContext(options); // Fail at startup if the runtime cannot load the algorithm or key.
  return options;
}
