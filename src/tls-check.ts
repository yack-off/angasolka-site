import {existsSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {loadTls} from './transport.js';
if(existsSync('.env'))process.loadEnvFile('.env');
const {TLS_CERT_FILE,TLS_KEY_FILE,PUBLIC_ORIGIN}=process.env;
if(!TLS_CERT_FILE||!TLS_KEY_FILE||!PUBLIC_ORIGIN?.startsWith('https://'))throw new Error('Set TLS_CERT_FILE, TLS_KEY_FILE and HTTPS PUBLIC_ORIGIN for this check');
const tls=await loadTls(TLS_CERT_FILE,TLS_KEY_FILE,PUBLIC_ORIGIN);
const certificate=new X509Certificate(tls.cert);
console.log(JSON.stringify({status:'valid_local_configuration',expires:certificate.validTo,daysRemaining:Math.floor((Date.parse(certificate.validTo)-Date.now())/86400000),browserTrust:'Must be verified on the deployed domain; local validation does not prove trust or revocation status.'},null,2));
