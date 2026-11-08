import https from 'node:https';
import dns from 'node:dns/promises';
import fs from 'node:fs';import path from 'node:path';
import {isPrivateIp} from './safe-fetch.js';
const API=new Set(['/x/frontend/finger/spi','/x/web-interface/nav','/x/web-interface/wbi/view','/x/player/wbi/playurl','/x/player/wbi/v2','/x/v2/subtitle/web/view','/x/web-interface/wbi/search/type','/x/web-interface/wbi/index/top/feed/rcmd']);
const AUTH=new Set(['/x/passport-login/web/qrcode/generate','/x/passport-login/web/qrcode/poll']);
export function checkBilibiliUrl(raw){
 let u;try{u=new URL(raw);}catch{throw Error('B站地址无效');}
 const api=u.hostname==='api.bilibili.com'&&API.has(u.pathname),auth=u.hostname==='passport.bilibili.com'&&AUTH.has(u.pathname);
 const subtitle=/(^|\.)hdslb\.com$/.test(u.hostname)&&(u.pathname.startsWith('/bfs/subtitle/')||u.pathname.startsWith('/bfs/ai_subtitle/'));
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||(!api&&!auth&&!subtitle))throw Error('拒绝未开放的B站接口（评论等写操作已禁用）');
 return {u,cookieAllowed:api||auth};
}
function fixedGet({url,address,headers,signal,maxBytes}){
 return new Promise((resolve,reject)=>{
  const req=https.request({hostname:address,port:443,servername:url.hostname,path:url.pathname+url.search,method:'GET',headers:{...headers,host:url.hostname},signal,timeout:15000},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy(Error('B站响应过大'));return;}chunks.push(chunk);});
   res.on('error',reject);res.on('aborted',()=>reject(Error('B站响应中断')));
   res.on('end',()=>{const h=new Headers();for(const [key,value]of Object.entries(res.headers))for(const v of [].concat(value??[]))h.append(key,String(v));
    resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:h}));});
  });req.on('timeout',()=>req.destroy(Error('B站请求超时')));req.on('error',reject);req.end();
 });
}
export function createBilibiliTransport({lookup=dns.lookup,requestImpl=fixedGet,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),authorize=()=>true,minGapMs=1500,stateDir}={}){
 let trafficError=false;
 let tail=Promise.resolve(),last=0,traffic={day:'',count:0,blockedUntil:0};
 const file=stateDir&&path.join(stateDir,'bilibili','traffic.json');
 if(file&&fs.existsSync(file))try{traffic=JSON.parse(fs.readFileSync(file,'utf8'));if(!Number.isFinite(traffic.count)||!Number.isFinite(traffic.blockedUntil))throw Error();}catch{trafficError=true;}
 const persist=()=>{if(!file)return;fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(traffic),{mode:0o600});fs.renameSync(tmp,file);};
 function block(){traffic.blockedUntil=now()+15*60000;persist();}
 function fetch(raw,init={}){
  let checked;try{checked=checkBilibiliUrl(raw);if(init.method&&init.method!=='GET'||init.body)throw Error('拒绝B站写请求');}catch(e){return Promise.reject(e);}
  const task=tail.then(async()=>{
   if(trafficError)throw Error('B站请求账本损坏，停止读取');
   if(!authorize()||init.signal?.aborted)throw Error('B站请求已关闭或取消');
   if(traffic.blockedUntil>now())throw Error('B站访问暂时暂停，请稍后查看状态');
   const day=new Date(now()+8*3600000).toISOString().slice(0,10);
   if(day!==traffic.day){traffic.day=day;traffic.count=0;}
   if(traffic.count>=300)throw Error('B站只读请求已达每日保护上限');
   const wait=minGapMs-(now()-last);if(wait>0)await sleep(wait);
   if(!authorize()||init.signal?.aborted)throw Error('B站请求权限变化或已取消');
   const {u,cookieAllowed}=checked,addresses=await lookup(u.hostname,{all:true,verbatim:true});
   if(!Array.isArray(addresses)||!addresses.length||addresses.some(v=>isPrivateIp(v.address)))throw Error('B站域名未解析为公开地址，拒绝私网');
   const incoming=new Headers(init.headers),headers={'user-agent':'Mozilla/5.0','accept':'application/json','referer':u.hostname==='passport.bilibili.com'?'https://passport.bilibili.com/login':'https://www.bilibili.com/'};
   if(cookieAllowed&&incoming.get('cookie'))headers.cookie=incoming.get('cookie');
   last=now();traffic.count++;persist();
   const signal=AbortSignal.any([AbortSignal.timeout(15000),...(init.signal?[init.signal]:[])]);
   let res;try{res=await requestImpl({url:u,address:addresses[0].address,headers,signal,maxBytes:init.maxBytes||131072});}catch{throw Error('B站读取失败或超时，未自动重试');}
   if([412,429].includes(res.status)){block();throw Error('B站限制访问，已暂停15分钟');}
   if(res.status>=300&&res.status<400)throw Error('B站接口跳转已拒绝，不转发凭据');
   const reader=res.body?.getReader();let size=0;const chunks=[];
   if(reader)try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>(init.maxBytes||131072))throw Error('B站响应过大');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
   if(!authorize()||signal.aborted)throw Error('B站请求已取消或权限变化');
   return new Response(Buffer.concat(chunks),{status:res.status,headers:res.headers});
  });tail=task.catch(()=>{});return task;
 }
 return {fetch,block,status:()=>({count:traffic.count,blockedUntil:traffic.blockedUntil})};
}
