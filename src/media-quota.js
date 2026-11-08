import fs from 'node:fs';
import path from 'node:path';
import {atomicUtilityJson} from './utility-store.js';
import {backupOwnerFile} from './owner-tools.js';
export function createVideoQuota({stateDir,now=Date.now,atomicWrite=atomicUtilityJson,backup=backupOwnerFile,perUser=20,global=60}={}){
  const file=path.join(stateDir,'media-video-quota.json');
  function take(ctx){
    let state={version:1,rows:[]};
    if(fs.existsSync(file))try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('视频额度存储损坏，已停止请求');}
    if(state.version!==1||!Array.isArray(state.rows)||state.rows.length>1000||state.rows.some(r=>!r||!/^[1-9]\d{0,11}$/.test(r.owner)||!Number.isFinite(r.at)))throw Error('视频额度存储损坏，已停止请求');
    const at=now(),owner=String(ctx.userId);if(!/^[1-9]\d{0,11}$/.test(owner))throw Error('视频请求主体无效');
    const rows=state.rows.filter(r=>r.at>at-86400000),own=rows.filter(r=>r.owner===owner);
    if(own.length>=perUser||rows.length>=global)throw Error('视频分析请求额度已满（本人每天'+perUser+'次，全局每天'+global+'次，含追问与失败尝试）');
    rows.push({owner,at});backup(file);atomicWrite(file,{version:1,rows});
  }
  return {take,file};
}
