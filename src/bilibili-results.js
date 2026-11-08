import fs from 'node:fs';
import path from 'node:path';
import {atomicUtilityJson} from './utility-store.js';
import {validTarget} from './bilibili-state.js';
import {validBvid} from './bilibili-client.js';
export const VIDEO_RESULT_TTL=3*86400000;
const MAX_ROWS=512,MAX_SUMMARIES=256,MAX_RECEIPTS=50000;
// Content expires within 72h; the separate receipt index contains no video text.
export function createBilibiliResults({stateDir,now=Date.now,getRoleVersion,atomicWrite=atomicUtilityJson}){
 const file=path.join(stateDir,'bilibili','video-results.json'),indexFile=path.join(stateDir,'bilibili','video-seen.json');
 const reference=n=>{const page=Number(n.page||1);if(!validBvid(n.bvid)||!Number.isInteger(page)||page<1||page>1000)throw Error('B站视频引用无效');return n.bvid+':'+page;};
 const validRef=ref=>typeof ref==='string'&&/^BV[A-Za-z0-9]{10}:(?:[1-9]\d{0,2}|1000)$/.test(ref);
 const scope=(ctx,shared=false)=>{if(!validTarget(ctx.sourceKey)||!/^[1-9]\d{0,11}$/.test(String(ctx.userId)))throw Error('B站视频上下文主体无效');return ctx.sourceKey+'|'+(shared?'shared':String(ctx.userId));};
 function persist(s){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});atomicWrite(file,s);}
 function index(){
  if(!fs.existsSync(indexFile))return {version:1,refs:{}};
  let s;try{s=JSON.parse(fs.readFileSync(indexFile,'utf8'));}catch{throw Error('B站已读索引损坏，已停止重复分析');}
  if(s?.version!==1||!s.refs||Array.isArray(s.refs)||typeof s.refs!=='object'||Object.keys(s.refs).length>MAX_RECEIPTS||JSON.stringify(s).length>5000000||Object.entries(s.refs).some(([k,v])=>!validRef(k)||!v||!Number.isFinite(v.firstAt)||!Number.isFinite(v.lastAt)||v.lastAt<v.firstAt))throw Error('B站已读索引损坏，已停止重复分析');
  return s;
 }
 function remember(rows){
  const s=index();let changed=!fs.existsSync(indexFile),count=Object.keys(s.refs).length;
  for(const r of rows){
   const at=r.analyzedAt??r.at,old=s.refs[r.ref];
   if(!old){if(count>=MAX_RECEIPTS)throw Error('B站已读索引容量已满，停止新分析，需维护索引');s.refs[r.ref]={firstAt:at,lastAt:at};count++;changed=true;}
   else if(at<old.firstAt||at>old.lastAt){old.firstAt=Math.min(old.firstAt,at);old.lastAt=Math.max(old.lastAt,at);changed=true;}
  }
  if(changed){fs.mkdirSync(path.dirname(indexFile),{recursive:true,mode:0o700});atomicWrite(indexFile,s);}
  return s;
 }
 function read(){
  if(!fs.existsSync(file)){index();return {version:1,rows:[]};}
  let s;try{s=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('B站视频结果缓存损坏，已停止重复分析');}
  if(s?.version!==1||!Array.isArray(s.rows)||s.rows.length>MAX_ROWS||s.rows.some(r=>!r||typeof r.scope!=='string'||!validRef(r.ref)||typeof r.role!=='string'||!Number.isFinite(r.at)||r.analyzedAt!==undefined&&(!Number.isFinite(r.analyzedAt)||r.analyzedAt>r.at)||r.publicEvidence!==undefined&&typeof r.publicEvidence!=='boolean'||r.summary!==null&&typeof r.summary!=='string'||typeof r.summary==='string'&&r.summary.length>4000)||JSON.stringify(s).length>4000000)throw Error('B站视频结果缓存损坏，已停止重复分析');
  // Migrate receipts before removing expired content; never revive missing summaries.
  remember(s.rows);let changed=false;
  s.rows=s.rows.filter(r=>{if(now()-(r.analyzedAt??r.at)>=VIDEO_RESULT_TTL){changed=true;return false;}if(r.analyzedAt===undefined){r.analyzedAt=r.at;changed=true;}return true;});
  if(changed)persist(s);return s;
 }
 function lookup(ctx,n){
  const ref=reference(n),own=scope(ctx),shared=scope(ctx,true),role=String(getRoleVersion()),s=read();
  const rows=s.rows.filter(r=>r.ref===ref&&(r.scope===own||r.scope===shared||r.publicEvidence===true)).sort((a,b)=>(b.analyzedAt??b.at)-(a.analyzedAt??a.at)||b.at-a.at);
  const r=rows.find(r=>r.summary&&(r.role===role||r.publicEvidence===true))||rows[0];
  if(r)return {...r,seen:true,summary:r.role===role||r.publicEvidence===true?r.summary:null};
  const receipts=index();if(receipts.refs[ref])return {seen:true,summary:null,analyzedAt:receipts.refs[ref].lastAt,coverage:'此前已分析，资料已过期或当前没有可复用的公开资料'};
  if(Object.keys(receipts.refs).length>=MAX_RECEIPTS)throw Error('B站已读索引容量已满，停止新分析，需维护索引');
  return null;
 }
 function save(ctx,n,value,shared=false){
  const ref=reference(n),sc=scope(ctx,shared),role=String(getRoleVersion()),s=read();
  const summary=String(value.summary||'').slice(0,4000);if(!summary)throw Error('不能缓存空视频结果');
  const prior=s.rows.filter(r=>r.ref===ref&&r.scope===sc&&r.role===role).sort((a,b)=>b.at-a.at)[0];
  const analyzedAt=Number(value.analyzedAt??prior?.analyzedAt??prior?.at??now());
  if(!Number.isFinite(analyzedAt)||analyzedAt>now())throw Error('视频实际分析时间无效');
  remember([{ref,at:analyzedAt}]);if(now()-analyzedAt>=VIDEO_RESULT_TTL)return false;
  s.rows=s.rows.filter(r=>!(r.ref===ref&&r.scope===sc&&r.role===role));
  s.rows.push({scope:sc,ref,role,at:now(),analyzedAt,publicEvidence:value.publicEvidence===true,summary,title:String(value.title||'').slice(0,180),cover:String(value.cover||'').slice(0,500),coverage:String(value.coverage||'仅已分析的采样资料').slice(0,300)});
  while(s.rows.length>MAX_ROWS)s.rows.shift();
  const summaries=s.rows.filter(r=>r.summary);for(const r of summaries.slice(0,Math.max(0,summaries.length-MAX_SUMMARIES)))r.summary=null;
  persist(s);return true;
 }
 function recent(ctx){
  const own=scope(ctx),shared=scope(ctx,true),role=String(getRoleVersion());
  const rows=read().rows;let r=rows.filter(r=>r.scope===own||r.scope===shared).sort((a,b)=>b.at-a.at)[0];
  if(!r&&ctx.sourceKey.startsWith('group:')){const other=rows.filter(r=>r.scope.startsWith(ctx.sourceKey+'|')).sort((a,b)=>b.at-a.at)[0];if(other)r={...other,summary:null,publicEvidence:false};}
  if(!r)return null;
  const [bvid,page]=r.ref.split(':');return {...r,bvid,page:Number(page),seen:true,summary:r.role===role||r.publicEvidence===true?r.summary:null};
 }
 function find(ctx,query){
  const own=scope(ctx),shared=scope(ctx,true),role=String(getRoleVersion()),text=String(query||'');
  let rows=read().rows.filter(r=>r.scope===own||r.scope===shared).sort((a,b)=>b.at-a.at);
  const day=86400000,offset=/前天/.test(text)?2:/昨天/.test(text)?1:/今天/.test(text)?0:null;
  if(offset!==null){const wanted=Math.floor((now()+8*3600000)/day)-offset;rows=rows.filter(r=>Math.floor(((r.analyzedAt??r.at)+8*3600000)/day)===wanted);}
  const unique=new Map();for(const r of rows)if(!unique.has(r.ref))unique.set(r.ref,r);rows=[...unique.values()];
  const stops=new Set(['视频','录像','短片','片子','今天','昨天','前天','之前','前面','上次','那条','那段','那个','这个','一下','总结','概括','讲讲','说说','内容','细节','刚才','刚刚','怎么','什么','怎样','里面','以前','回忆','回顾','记得','我','你','的','是','了','啊','吗','呢','把','给','看','想','再','能','要','做','说','讲','它','这','那','一','个','里']);
  const tokens=[...new Intl.Segmenter('zh',{granularity:'word'}).segment(text)].filter(x=>x.isWordLike&&!stops.has(x.segment)).map(x=>x.segment);
  if(tokens.length){const scored=rows.map(r=>({r,score:tokens.reduce((n,t)=>n+(String(r.title||'').includes(t)?t.length:0),0)}));const best=Math.max(0,...scored.map(x=>x.score));rows=scored.filter(x=>x.score===best&&best>0).map(x=>x.r);}
  if(!rows.length)throw Error('没有找到对应视频的3天内资料，请引用原视频或提供链接/BV，不会自动重读');
  if(rows.length>1)throw Error('有多条可能的视频，请引用想问的那条或提供链接/BV，避免答错视频');
  const r=rows[0],[bvid,page]=r.ref.split(':');return {...r,bvid,page:Number(page),seen:true,summary:r.role===role||r.publicEvidence===true?r.summary:null};
 }
 return {file,indexFile,lookup,save,recent,find,prune:()=>read(),reference};
}
