import{normalizeBilibiliInput}from'./bilibili-client.js';
import fs from'node:fs';import path from'node:path';import{randomUUID}from'node:crypto';
import{atomicUtilityJson}from'./utility-store.js';
export const biliDay=at=>new Date(at+8*3600000).toISOString().slice(0,10);
export const validTarget=v=>/^(private|group):[1-9]\d{0,11}$/.test(String(v));
const numeric=v=>Number.isInteger(v)&&v>=0&&v<=100;
export function createBilibiliState({stateDir,now=Date.now,atomicWrite=atomicUtilityJson}){
 const file=path.join(stateDir,'bilibili','control.json');
 const blank=()=>({version:1,revision:0,limits:{privateDaily:1,groupDaily:3,browseDaily:6},targets:{},reads:[],shares:[],seen:{}});
 function validate(s){
  if(s?.version!==1||!Number.isSafeInteger(s.revision)||!s.limits||!Object.values(s.limits).every(numeric)||!['privateDaily','groupDaily','browseDaily'].every(k=>numeric(s.limits[k]))||!s.targets||Array.isArray(s.targets)||!Array.isArray(s.reads)||!Array.isArray(s.shares)||!s.seen||typeof s.seen!=='object')throw Error('B站状态损坏，已停止读写');
  for(const[k,v]of Object.entries(s.targets))if(!validTarget(k)||typeof v.enabled!=='boolean'||!Number.isInteger(v.interval)||v.interval<30||v.interval>1440||!Number.isInteger(v.start)||!Number.isInteger(v.end)||v.start<0||v.start>23||v.end<1||v.end>24||v.start>=v.end||!Number.isFinite(v.dueAt))throw Error('B站目标设置损坏');
  for(const t of Object.values(s.targets)){if(t.dailyLimit!==undefined&&!numeric(t.dailyLimit))throw Error('B站会话限额损坏');if(t.manualSelect!==undefined&&typeof t.manualSelect!=='boolean')throw Error('B站会话选择设置损坏');}
  if(s.autoSelect!==undefined&&typeof s.autoSelect!=='boolean')throw Error('B站自动选择设置损坏');
  for(const t of Object.values(s.targets)){if(t.schedule!==undefined&&!['daily','interval'].includes(t.schedule))throw Error('B站计划类型损坏');if(t.plan&&(!/^\d{4}-\d{2}-\d{2}$/.test(t.plan.day)||!Array.isArray(t.plan.slots)||t.plan.slots.length>3||t.plan.slots.some(v=>!Number.isFinite(v))||!Number.isInteger(t.plan.cursor)||t.plan.cursor<0||t.plan.cursor>t.plan.slots.length))throw Error('B站每日计划损坏');}
  for(const r of s.reads)if(!r||typeof r.id!=='string'||!Number.isFinite(r.at)||typeof r.bvid!=='string'||typeof r.day!=='string')throw Error('B站浏览账本损坏');
  for(const r of s.shares)if(!r||typeof r.id!=='string'||!Number.isFinite(r.at)||!validTarget(r.sourceKey)||typeof r.automatic!=='boolean'||!['pending','sent','failed'].includes(r.status))throw Error('B站分享账本损坏');
  if(s.cards!==undefined&&(!Array.isArray(s.cards)||s.cards.length>256||s.cards.some(r=>!r||!validTarget(r.sourceKey)||!Number.isSafeInteger(Number(r.messageId))||Number(r.messageId)===0||!normalizeBilibiliInput(r.url)?.bvid||!Number.isFinite(r.at))))throw Error('B站卡片引用记录损坏');
  if(s.reads.length>3000||s.shares.length>3000||JSON.stringify(s).length>1500000)throw Error('B站状态容量超限');
  return s;
 }
 function read(){if(!fs.existsSync(file))return blank();try{return validate(JSON.parse(fs.readFileSync(file,'utf8')));}catch{throw Error('B站状态损坏，已停止读写');}}
 function update(fn,{settings=false}={}){
  const s=read();s.reads=s.reads.filter(r=>now()-r.at<8*86400000);s.shares=s.shares.filter(r=>now()-r.at<8*86400000);
  for(const[k,v]of Object.entries(s.seen))if(now()-v>7*86400000)delete s.seen[k];
  const result=fn(s);if(result?.then)throw Error('B站状态更新须同步');if(settings)s.revision++;
  validate(s);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if(fs.existsSync(file)){const backup=file+'.bak';fs.copyFileSync(file,backup);fs.chmodSync(backup,0o600);}
  atomicWrite(file,s);return result;
 }
 const target=(key,s=read())=>s.targets[key]||{enabled:false,interval:180,start:20,end:24,dueAt:0};
 function readCount(s=read()){return s.reads.filter(r=>r.day===biliDay(now())).length;}
 function shareCount(key,s=read()){return s.shares.filter(r=>r.sourceKey===key&&r.automatic&&r.status!=='failed'&&r.day===biliDay(now())).length;}
 function shareLimit(key,s=read()){return target(key,s).dailyLimit??(key.startsWith('group:')?s.limits.groupDaily:s.limits.privateDaily);}
 function wasShared(key,bvid,s=read()){return s.shares.some(r=>r.sourceKey===key&&r.bvid===bvid&&r.automatic&&r.status!=='failed'&&now()-r.at<7*86400000);}
 function reserveRead({bvid,roleVersion}){
  return update(s=>{if(readCount(s)>=Math.min(6,s.limits.browseDaily))throw Error('B站每日浏览深读额度已满');
   const id=randomUUID();s.reads.push({id,bvid,roleVersion,at:now(),day:biliDay(now())});return id;});
 }
 function reserveShare({sourceKey,bvid,automatic}){
  if(!validTarget(sourceKey))throw Error('QQ分享目标无效');
  return update(s=>{if(automatic&&(shareCount(sourceKey,s)>=shareLimit(sourceKey,s)||wasShared(sourceKey,bvid,s)))throw Error('B站主动分享额度已满或本视频已分享');
   const id=randomUUID();s.shares.push({id,bvid,sourceKey,automatic,at:now(),day:biliDay(now()),status:'pending'});return id;});
 }
 function finishShare(id,receipt){update(s=>{const r=s.shares.find(v=>v.id===id);if(!r)throw Error('B站发送账目缺失');if(receipt===true||receipt?.sent===true)r.status='sent';else if(receipt===false)r.status='failed';});}
 function rememberCard({sourceKey,messageId,url}){
  const n=normalizeBilibiliInput(url);if(!validTarget(sourceKey)||!n?.bvid||!Number.isSafeInteger(Number(messageId))||Number(messageId)===0)throw Error('B站卡片引用无效');
  update(s=>{s.cards=(s.cards||[]).filter(r=>now()-r.at<7*86400000&&!(r.sourceKey===sourceKey&&r.messageId===String(messageId))).slice(-255);s.cards.push({sourceKey,messageId:String(messageId),url:n.url,at:now()});});
 }
 function cardReference(sourceKey,messageId){const r=(read().cards||[]).find(r=>r.sourceKey===sourceKey&&r.messageId===String(messageId)&&now()-r.at<7*86400000);return r?{platform:'bilibili',url:r.url}:null;}
 return{file,read,update,target,readCount,shareCount,shareLimit,wasShared,rememberCard,cardReference,reserveRead,reserveShare,finishShare,finishRead:id=>update(s=>{const r=s.reads.find(v=>v.id===id);if(r)s.seen[r.bvid]=now();})};
}
