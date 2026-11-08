import{validBvid}from'./bilibili-client.js';
import{VIDEO_RESULT_TTL}from'./bilibili-results.js';
export function createBilibiliExperience({client,role,results,media,send,state,canNotify,isAllowed,redact=String,now=Date.now,recordEvent=()=>{}}){
 const recent=new Map(),sharedContexts=new Map();let sources='尚未浏览首页推荐及兴趣搜索';
 const actor=c=>JSON.stringify([c.sourceKey,String(c.userId)]);
 const check=(ctx,o)=>{if(!o.authorize()||!isAllowed(o.targetKey||ctx.sourceKey)||o.automatic&&!canNotify(o.targetKey||ctx.sourceKey))throw Error('本次B站操作已取消或权限变化');};
 async function deliver(ctx,info,o,summary){
  check(ctx,o);const key=o.targetKey||ctx.sourceKey;
  if(o.automatic&&(state.shareCount(key)>=state.shareLimit(key)||state.wasShared(key,info.bvid)))return false;
  const shareRole=role.snapshot().version;
  const text=summary?await role.composeShare(ctx,{title:info.candidate.title,description:info.candidate.description,evidence:summary,coverage:info.coverage,missing:info.missing}):info.candidate.title;
  check(ctx,o);
  const job=state.reserveShare({sourceKey:key,bvid:info.bvid,automatic:!!o.automatic});
  try{
   const authorize=()=>{try{check(ctx,o);if(o.automatic&&state.shareCount(key)>state.shareLimit(key))return false;return true;}catch{return false;}};
   const receipt=await send(key,redact(text)+'\n'+info.candidate.url,{manual:!o.automatic,authorize,comment:summary?redact(text):'',card:{url:info.candidate.url,title:redact(info.candidate.title),image:info.candidate.cover||'',content:redact(summary?text:info.candidate.description||'哔哩哔哩视频')}});
   state.finishShare(job,receipt===false?false:receipt===true||receipt?.sent===true?true:null);
   recordEvent('video-share',{key,bvid:info.bvid,status:receipt===true||receipt?.sent===true?'sent':'unconfirmed',detail:receipt?.commentSent?redact(text):'本次没有确认补充感想'},info.analyzedAt??now());
   if(receipt!==true&&receipt?.sent!==true)throw Error('QQ分享未确认送达，不自动重发');
   for(const[k,v]of sharedContexts)if(now()-v.at>900000)sharedContexts.delete(k);
   if(sharedContexts.size>=100&&!sharedContexts.has(key))sharedContexts.delete(sharedContexts.keys().next().value);
   sharedContexts.set(key,{summary:redact((summary||'仅分享了标题和链接，未读取画面')+'\nQQ已分享视频图文：'+info.candidate.title+(receipt?.commentSent?'\nQQ已补充感想：'+text:'')).slice(0,3500),url:info.candidate.url,at:now(),roleVersion:shareRole,coverage:info.coverage,evidenceExpiresAt:summary?(info.analyzedAt??now())+VIDEO_RESULT_TTL:undefined,source:'bilibili-shared-evidence',bvid:info.bvid,page:info.page||1,analyzed:!!summary});
   if(summary&&results)results.save({...ctx,sourceKey:key},{bvid:info.bvid,page:info.page||1},{summary,analyzedAt:info.analyzedAt,publicEvidence:info.publicEvidence,title:info.candidate.title,cover:info.candidate.cover,coverage:info.coverage},true);
   return true;
  }catch(e){recordEvent('video-share',{key,bvid:info.bvid,status:'unconfirmed',detail:'发送结果未确认；不会自动重发'},info.analyzedAt??now());throw e;}
 }
 function cachedResult(ctx,o,n){
  const dest=o.targetKey||ctx.sourceKey,target=results?.lookup({...ctx,sourceKey:dest},n);
  // An explicit administrator share may carry their own public-video evidence to the requested target.
  const own=dest!==ctx.sourceKey?results?.lookup(ctx,n):target;
  const transferable=dest!==ctx.sourceKey&&own&&!own.publicEvidence?{...own,summary:null}:own;
  return target?.summary?target:transferable?.summary?transferable:target||transferable;
 }
 async function cachedInfo(n,cached){
  const metadata=cached.title?null:await client.read(n.bvid,{page:n.page,details:false});
  return{bvid:n.bvid,page:n.page,candidate:{title:cached.title||metadata.candidate.title,cover:cached.cover||metadata?.candidate.cover||'',description:'',url:n.url},coverage:cached.coverage,analyzedAt:cached.analyzedAt??cached.at,publicEvidence:cached.publicEvidence,missing:[]};
 }
 async function share(ctx,o){
  check(ctx,o);const n=await client.resolve(o.input),cached=cachedResult(ctx,o,n);
  if(cached){
   if(!cached.summary){const info=await client.read(n.bvid,{page:n.page,details:false});return deliver(ctx,info,o,null);}
   return deliver(ctx,await cachedInfo(n,cached),o,cached.summary);
  }
  const info=await client.read(n.bvid,{page:n.page,details:false});
  check(ctx,o);recent.set(actor(ctx),{url:info.candidate.url,at:now()});
  return deliver(ctx,info,o,null);
 }
 async function watch(ctx,o){
  check(ctx,o);const n=await client.resolve(o.input),cached=cachedResult(ctx,o,n);
  check(ctx,o);
  if(cached){
   if(!cached.summary)throw Error('这个视频之前已分析，当前没有可复用资料；需重看可发[重新看视频][链接]，会占用当日分析额度');
   return deliver(ctx,await cachedInfo(n,cached),o,cached.summary);
  }
  const info=await client.read(n.bvid,{page:n.page});check(ctx,o);
  if(!info.mediaUrl)throw Error('未取得可观看的视频，未完成观看或分享；可用[分享视频]仅发送标题和链接');
  const mediaCtx={...ctx,sourceKey:o.targetKey||ctx.sourceKey};
  const observation=await media().observeResolved(mediaCtx,{...info,platform:'bilibili',title:info.candidate.title,description:info.candidate.description,displayUrl:info.candidate.url},{authorize:o.authorize,quotaSource:'reply'});
  check(ctx,o);if(!observation?.summary)throw Error('没有取得可用的视频观看资料，未分享');
  info.coverage='已分析受限采样画面；'+info.coverage;info.analyzedAt=observation.analyzedAt;info.publicEvidence=observation.publicEvidence;
  recent.set(actor(ctx),{url:info.candidate.url,at:now()});
  return deliver(ctx,info,o,observation.summary);
 }
 async function browse(ctx,o){
  check(ctx,o);const dest=o.targetKey||ctx.sourceKey;
  if(o.automatic&&state.shareCount(dest)>=state.shareLimit(dest))return {selected:false,reason:'share-quota'};
  if(state.readCount()>=Math.min(6,state.read().limits.browseDaily))throw Error('B站每日浏览深读额度已满');
  const words=await role.keywords(ctx);check(ctx,o);
  const rs=await Promise.allSettled([client.recommend({limit:3}),client.search(words[state.readCount()%words.length],{limit:3})]);
  sources=rs.map((r,i)=>(i?'人物兴趣搜索':'账号首页推荐')+'：'+(r.status==='fulfilled'?'成功':'本轮未取得')).join('；');
  check(ctx,o);
  const seen=new Set(),s=state.read(),pool=rs.filter(r=>r.status==='fulfilled').flatMap(r=>r.value).filter(v=>validBvid(v.bvid)&&!seen.has(v.bvid)&&(seen.add(v.bvid),true)&&!(s.seen[v.bvid]>now()-7*86400000)&&(!o.automatic||!state.wasShared(dest,v.bvid,s))).slice(0,6);
  let candidatesEvidenceAt=now();
  for(let i=pool.length-1;i>=0;i--){const cached=results?.lookup({...ctx,sourceKey:dest,userId:dest.startsWith('private:')?dest.split(':')[1]:ctx.userId},{bvid:pool[i].bvid,page:1});if(cached&&!cached.summary)pool.splice(i,1);else if(cached?.analyzedAt||cached?.at)candidatesEvidenceAt=Math.min(candidatesEvidenceAt,cached.analyzedAt??cached.at);}
  if(!pool.length)throw Error('本轮没有可用的新视频；'+sources);
  recordEvent('video-candidates',{key:dest,status:'candidates',detail:'搜索词：'+words[state.readCount()%words.length]+'；'+sources,candidates:pool},candidatesEvidenceAt);
  const bvid=await role.choose(ctx,pool);check(ctx,o);
  recordEvent('video-selection',{key:dest,bvid:bvid||'',status:bvid?'selected':'skipped',detail:bvid?'从真实候选中选择':'本轮未选择视频'});
  if(!bvid)return {selected:false};
  if(o.automatic&&state.shareCount(dest)>=state.shareLimit(dest))return {selected:false,reason:'share-quota'};
  const cached=results?.lookup({...ctx,sourceKey:dest,userId:dest.startsWith('private:')?dest.split(':')[1]:ctx.userId},{bvid,page:1});
  if(cached){
   if(!cached.summary)return {selected:false,reason:'already-read'};
   const candidate=pool.find(v=>v.bvid===bvid),info={bvid,page:1,candidate:{...candidate,cover:cached.cover||candidate.cover},coverage:cached.coverage,analyzedAt:cached.analyzedAt??cached.at,publicEvidence:cached.publicEvidence,missing:[]};
   return {selected:true,sent:await deliver(ctx,info,o,cached.summary),bvid,reused:true};
  }
  const job=state.reserveRead({bvid,roleVersion:role.snapshot().version});
  const info=await client.read(bvid);
  info.candidate.origin=pool.find(v=>v.bvid===bvid)?.origin||info.candidate.origin;
  check(ctx,o);
  let evidence={metadata:{title:info.candidate.title,description:info.candidate.description},subtitles:info.subtitles,coverage:info.coverage,missing:info.missing};
  if(info.mediaUrl)try{
   const observation=await media().observeResolved(ctx,{...info,platform:'bilibili',title:info.candidate.title,description:info.candidate.description,displayUrl:info.candidate.url},{authorize:o.authorize,quotaSource:'browse'});
   evidence={...evidence,observation:observation.summary,coverage:'已分析受限采样画面；'+info.coverage};info.analyzedAt=observation.analyzedAt;info.publicEvidence=observation.publicEvidence;
  }catch(e){check(ctx,o);evidence.missing=[...info.missing,'画面未完成：'+String(e.message).slice(0,100)];}
  check(ctx,o);state.finishRead(job);recent.set(actor(ctx),{url:info.candidate.url,at:now()});
  info.coverage=evidence.coverage;
  // Keep observations ahead of long subtitle tracks within the existing context budget.
  const facts={observation:String(evidence.observation||'').slice(0,2800),metadata:{title:String(evidence.metadata.title||'').slice(0,160),description:String(evidence.metadata.description||'').slice(0,200)},coverage:String(evidence.coverage||'').slice(0,160),missing:(evidence.missing||[]).slice(0,3).map(v=>String(v).slice(0,80)),subtitles:(evidence.subtitles||[]).slice(0,6).map(v=>({from:v.from,to:v.to,text:String(v.text||'').slice(0,80)}))};
  let summary=JSON.stringify(facts);
  while(summary.length>3400&&facts.subtitles.length){facts.subtitles.pop();summary=JSON.stringify(facts);}
  while(summary.length>3400&&facts.observation.length){facts.observation=facts.observation.slice(0,-100);summary=JSON.stringify(facts);}
  const sent=await deliver(ctx,info,o,summary);
  return {selected:true,sent,bvid};
 }
 return{browse,share,watch,prune:()=>{for(const[k,v]of sharedContexts)if(now()-v.at>=900000||v.evidenceExpiresAt<=now())sharedContexts.delete(k);},sourceStatus:()=>sources,chatContext:key=>{const v=sharedContexts.get(key);if(!v||now()-v.at>=900000||v.evidenceExpiresAt<=now()){sharedContexts.delete(key);return null;}try{return v.roleVersion===role.snapshot().version?{...v}:null;}catch{return null;}},recentVideoRef:ctx=>{const v=recent.get(actor(ctx));return v&&now()-v.at<900000?{...v}:null;},recentVideo:ctx=>{const r=recent.get(actor(ctx));return r&&now()-r.at<900000?r.url:null;}};
}
