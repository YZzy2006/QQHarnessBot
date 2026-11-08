import {signWbi} from './vendor/dsh-bili-whale/wbi.js';
import {extractVideoSource} from './media-sources.js';
export const validBvid=v=>/^BV[A-Za-z0-9]{10}$/.test(String(v));
const clean=(v,n=180)=>String(v??'').replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f]/g,' ').slice(0,n);
export function normalizeBilibiliInput(input){
 const text=String(input||'').trim();if(validBvid(text))return {bvid:text,page:1,url:'https://www.bilibili.com/video/'+text};
 let u;try{u=new URL(text);}catch{return null;}
 if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 if(u.hostname==='b23.tv')return {url:u.href,short:true,page:1};
 if(u.hostname!=='www.bilibili.com'&&u.hostname!=='bilibili.com'&&u.hostname!=='m.bilibili.com')return null;
 const bvid=/^\/video\/(BV[A-Za-z0-9]{10})(?:\/|$)/.exec(u.pathname)?.[1],page=Number(u.searchParams.get('p')||1);
 if(!bvid||!Number.isInteger(page)||page<1||page>1000)return null;
 return {bvid,page,url:'https://www.bilibili.com/video/'+bvid+(page>1?'?p='+page:'')};
}
export function createBilibiliClient({transport,auth,now=Date.now,resolveShort}){
 let navCache=null,navAt=0,navGeneration=-1,deviceId='',deviceGeneration=-1,devicePending=null;
 const cookie=()=>{const c=auth.read(),gen=auth.generation?.()||0,b=c?.buvid3||(deviceGeneration===gen?deviceId:'');return c?('SESSDATA='+c.sessdata+'; bili_jct='+c.bili_jct+(b?'; buvid3='+b:'')):'';};
 async function get(endpoint,params={},signal,signed=false,anonymous=false){
  if(!auth.read())throw Error('B站尚未登录，请管理员私聊发送[B站登录]');
  let query=new URLSearchParams(params).toString();
  if(signed){const nav=await navInfo(signal);query=signWbi(params,nav.wbi_img,now());}
  const res=await transport.fetch('https://api.bilibili.com'+endpoint+(query?'?'+query:''),{headers:anonymous?undefined:{cookie:cookie()},signal,maxBytes:endpoint==='/x/web-interface/wbi/view'?2*1024*1024:524288});
  if(!res.ok)throw Error('B站接口返回HTTP '+res.status);
  let data;try{data=await res.json();}catch{throw Error('B站接口未返回有效资料');}
  if([-412,-352,-799,-509,-10403].includes(data.code)){transport.block();throw Error('B站访问受限，读取已暂停');}
  if([-101,-111].includes(data.code))throw Error('B站登录态已失效，请重新扫码');
  if(data.code!==0)throw Error('B站读取失败，代码'+Number(data.code));
  return data.data;
 }
 async function navInfo(signal){
  const gen=auth.generation?.()||0;
  if(gen!==deviceGeneration){deviceId='';deviceGeneration=gen;}
  if(!auth.read()?.buvid3&&!deviceId){
   if(!devicePending||devicePending.generation!==gen){
    const pending={generation:gen};devicePending=pending;
    pending.promise=(async()=>{
     const device=await get('/x/frontend/finger/spi',{},signal,false,true),value=String(device?.b_3||'');
     if(!/^[A-Za-z0-9_-]{10,200}$/.test(value))throw Error('未取得有效B站设备标识，停止读取');
     if(gen!==(auth.generation?.()||0))throw Error('B站登录态已变化，停止读取');
     deviceId=value;
    })().finally(()=>{if(devicePending===pending)devicePending=null;});
   }
   await devicePending.promise;
  }
  if(!navCache||gen!==navGeneration||now()-navAt>=600000){
   const n=await get('/x/web-interface/nav',{},signal);
   if(!n?.isLogin)throw Error('B站登录态已失效，请重新扫码');
   navCache=n;navAt=now();navGeneration=gen;
  }return navCache;
 }
 const candidate=(v,origin)=>({bvid:v.bvid,title:clean(v.title),cover:clean(v.pic,500),description:clean(v.description||v.desc,500),owner:clean(v.owner?.name||v.author,80),duration:v.duration,url:'https://www.bilibili.com/video/'+v.bvid,origin});
 async function recommend({limit=3,signal}={}){
  await navInfo(signal);
  const d=await get('/x/web-interface/wbi/index/top/feed/rcmd',{fresh_type:4,ps:12,fresh_idx:1,fresh_idx_1h:1,fetch_row:1,web_location:1430650,feed_version:'V8',homepage_ver:1},signal,true);
  if(!Array.isArray(d?.item))throw Error('B站首页推荐返回结构不兼容');
  return d.item.filter(v=>validBvid(v.bvid)&&(!v.goto||v.goto==='av')&&!v.ad_info).slice(0,Math.min(limit,3)).map(v=>candidate(v,'home'));
 }
 async function search(keyword,{limit=3,signal}={}){
  const kw=String(keyword||'').trim();if(!kw||kw.length>40)throw Error('B站兴趣词无效');
  const d=await get('/x/web-interface/wbi/search/type',{search_type:'video',keyword:kw,page:1,page_size:20},signal,true);
  if(!Array.isArray(d?.result))throw Error('B站搜索返回结构不兼容');
  return d.result.filter(v=>validBvid(v.bvid)).slice(0,Math.min(limit,3)).map(v=>candidate(v,'interest'));
 }
 async function resolve(input,{signal}={}){
  let n=normalizeBilibiliInput(input);
  if(n?.short){
   if(!resolveShort)throw Error('请使用完整B站链接或BV号');
   n=normalizeBilibiliInput(await resolveShort(n.url,{signal}));
  }
  if(!n?.bvid)throw Error('未识别有效B站视频链接或BV号');
  return n;
 }
 async function read(bvid,{page=1,signal,details=true}={}){
  if(!validBvid(bvid))throw Error('BV号无效');
  const v=await get('/x/web-interface/wbi/view',{bvid},signal,true);
  const part=v?.pages?.find(p=>p.page===page)||(page===1&&v?.cid?{cid:v.cid}:null);
  if(!part?.cid)throw Error('视频分P不存在或不可访问');
  const out={candidate:{...candidate(v,'shared'),url:'https://www.bilibili.com/video/'+bvid+(page>1?'?p='+page:'')},bvid,cid:part.cid,page,subtitles:[],mediaUrl:'',coverage:'仅元数据',missing:[]};
  if(!details)return out;
  try{
   const player=await get('/x/player/wbi/v2',{bvid,cid:part.cid},signal,true);
   const subs=player?.subtitle?.subtitles||[],s=subs.find(x=>x.lan==='zh-CN')||subs.find(x=>String(x.lan).startsWith('zh')||x.lan==='ai-zh')||subs[0];
   if(s?.subtitle_url){
    const u=String(s.subtitle_url).startsWith('//')?'https:'+s.subtitle_url:s.subtitle_url;
    const response=await transport.fetch(u,{signal,maxBytes:524288});
    if(!response.ok)throw Error('字幕读取失败');
    const rows=(await response.json()).body;
    if(!Array.isArray(rows))throw Error('字幕格式无效');
    let size=0;
    out.subtitles=rows.filter(x=>Number.isFinite(x.from)&&Number.isFinite(x.to)&&typeof x.content==='string').slice(0,500).map(x=>({from:x.from,to:x.to,text:clean(x.content,300)})).filter(x=>(size+=x.text.length)<=18000);
    out.coverage=out.subtitles.length?'元数据与部分字幕（最多18000字/500行）':'仅元数据';
   }
   if(!out.subtitles.length)out.missing.push('无可用字幕');
  }catch(e){out.missing.push('字幕未取得');}
  if(Number(v.duration)<=600)try{
   const p=await get('/x/player/wbi/playurl',{bvid,cid:part.cid,qn:16,fnval:0,fnver:0,fourk:0,platform:'html5'},signal,true);
   const d=p?.durl;if(Array.isArray(d)&&d.length===1&&Number(d[0].size||0)<=32*1024*1024)out.mediaUrl=d[0].url||'';
   if(!out.mediaUrl)out.missing.push('未取得预算内完整视频流');
  }catch{out.missing.push('画面下载地址未取得');}
  else out.missing.push('视频超过10分钟，未请求画面');
  return out;
 }
 return {recommend,search,read,resolve,verify:()=>navInfo(),getSource:async(input,options={})=>{
  const n=await resolve(input,options),v=await read(n.bvid,{...options,page:n.page});
  if(!v.mediaUrl)throw Error('未取得预算内画面，请稍后重试或发送原视频');
  return {platform:'bilibili',title:v.candidate.title,cover:v.candidate.cover,description:v.candidate.description,mediaUrl:v.mediaUrl,displayUrl:n.url,bvid:n.bvid,page:n.page,subtitles:v.subtitles};
 }};
}
