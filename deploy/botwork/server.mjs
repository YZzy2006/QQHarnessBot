import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','host','x-console-token']);
export function createBotWorkServer({upstreamPort=3100,timeout=30000}={}) {
  const server=http.createServer(async(req,res)=>{
    const port=server.address()?.port;
    if(![`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(String(req.headers.host||'').toLowerCase()))return json(res,403,{ok:false,error:'Host不被允许'});
    let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{return json(res,400,{ok:false,error:'请求地址无效'});}
    const health=url.pathname==='/healthz'&&req.method==='GET';
    if(!health&&!url.pathname.startsWith('/api/workbench/'))return json(res,404,{ok:false,error:'接口不存在'});
    if(!['GET','POST'].includes(req.method))return json(res,405,{ok:false,error:'请求方法不支持'});
    const bodyLimit=url.pathname==='/api/workbench/portrait/upload'?3*1024*1024:1000000;
    let chunks=[],size=0;
    if(Number(req.headers['content-length'])>bodyLimit)return json(res,413,{ok:false,error:'请求过大'});
    try{for await(const chunk of req){size+=chunk.length;if(size>bodyLimit){req.resume();return json(res,413,{ok:false,error:'请求过大'});}chunks.push(chunk);}}
    catch{return json(res,400,{ok:false,error:'请求未完成'});}
    const headers={host:`127.0.0.1:${upstreamPort}`};
    if(!health)for(const [key,value]of Object.entries(req.headers)){if(!hop.has(key)&&value!==undefined)headers[key]=value;}
    if(req.method==='POST')headers['content-length']=String(size);
    const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,
      path:health?'/api/workbench/session':url.pathname+url.search,method:health?'GET':req.method,headers,timeout},reply=>{
      if(health){reply.resume();return json(res,reply.statusCode===401?200:503,{ok:reply.statusCode===401,service:'BotWork',backend:reply.statusCode===401?'ready':'unavailable'});}
      const safeHeaders={};
      for(const [key,value]of Object.entries(reply.headers))if(!hop.has(key)&&value!==undefined)safeHeaders[key]=value;
      res.writeHead(reply.statusCode||502,safeHeaders);reply.pipe(res);
      reply.on('error',()=>res.destroy());
    });
    upstream.on('timeout',()=>upstream.destroy(Error('timeout')));
    upstream.on('error',()=>{if(!res.headersSent)json(res,502,{ok:false,error:'机器人接口暂不可用，请稍后重试'});else res.destroy();});
    res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});
    upstream.end(size?Buffer.concat(chunks):undefined);
  });
  server.headersTimeout=10000;
  server.requestTimeout=60000;
  return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const raw=process.env.PORT||process.env.BOTWORK_PORT||'3188';
  const port=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT必须为1024至65535之间的端口');
  const server=createBotWorkServer();
  server.listen(port,'127.0.0.1',()=>console.log(`BotWork listening on http://127.0.0.1:${port}`));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;server.close(()=>process.exit(0));setTimeout(()=>{server.closeAllConnections();process.exit(0);},5000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
