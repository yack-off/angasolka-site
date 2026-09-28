import {createServer,request,type IncomingHttpHeaders} from 'node:http';
import {isIP} from 'node:net';

// Only cloudflared connects here. Do not trust a visitor-supplied forwarding chain.
export function tunnelHeaders(headers:IncomingHttpHeaders,origin:string):IncomingHttpHeaders|null {
  const ip=headers['cf-connecting-ip'];
  if(headers.host!==new URL(origin).host||headers['x-forwarded-proto']!=='https'||typeof ip!=='string'||!isIP(ip))return null;
  const cleaned={...headers};
  for(const key of Object.keys(cleaned))if(key.startsWith('x-forwarded-')||key==='forwarded')delete cleaned[key];
  return {...cleaned,'x-forwarded-for':ip,'x-forwarded-proto':'https','x-forwarded-host':new URL(origin).host};
}

export function demoProxy(port:number,getOrigin:()=>string|undefined) {
  return createServer((req,res)=>{
    const origin=getOrigin();
    const headers=origin?tunnelHeaders(req.headers,origin):null;
    if(!headers){res.writeHead(origin?403:503);res.end('Preview is not ready');return;}
    const upstream=request({hostname:'127.0.0.1',port,method:req.method,path:req.url,headers},reply=>{
      res.writeHead(reply.statusCode??502,{...reply.headers,'x-robots-tag':'noindex, nofollow, noarchive'});reply.pipe(res);
    });
    upstream.setTimeout(20000,()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Preview temporarily unavailable');});
    req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  });
}
