import fs from 'node:fs';
import path from 'node:path';
import {atomicUtilityJson} from './utility-store.js';
import {biliDay,validTarget} from './bilibili-state.js';
export function createBilibiliReplyQuota({stateDir,now=Date.now,atomicWrite=atomicUtilityJson}){
 const file=path.join(stateDir,'bilibili','reply-quota.json');
 function read(){
  if(!fs.existsSync(file))return {version:1,rows:[]};
  let s;try{s=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('B站回复额度损坏，已停止请求');}
  if(s?.version!==1||!Array.isArray(s.rows)||s.rows.length>10000||s.rows.some(r=>!validTarget(r.key)||!Number.isFinite(r.at)||r.day!==biliDay(r.at)))throw Error('B站回复额度损坏，已停止请求');
  return s;
 }
 const limit=key=>key.startsWith('group:')?9:6;
 const count=(key,s=read())=>s.rows.filter(r=>r.key===key&&r.day===biliDay(now())).length;
 function take(ctx){
  if(!validTarget(ctx.sourceKey)||!/^[1-9]\d{0,11}$/.test(String(ctx.userId)))throw Error('B站视频请求主体无效');
  const s=read();if(count(ctx.sourceKey,s)>=limit(ctx.sourceKey))throw Error('本'+(ctx.sourceKey.startsWith('group:')?'群':'私聊')+'B站视频分析每日'+limit(ctx.sourceKey)+'条额度已满（失败尝试计额，复用结果不计额）');
  s.rows=s.rows.filter(r=>now()-r.at<2*86400000);s.rows.push({key:ctx.sourceKey,at:now(),day:biliDay(now())});
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});if(fs.existsSync(file))fs.copyFileSync(file,file+'.bak');atomicWrite(file,s);
 }
 return {file,take,count,limit};
}
