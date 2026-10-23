import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {backupOwnerFile} from './owner-tools.js';
import {atomicUtilityJson} from './utility-store.js';
export const PRIVATE_REPORT_MARKER='【管理员私有周记｜不入聊天记忆】';
const hash=v=>crypto.createHash('sha256').update(String(v).replace(/\s+/g,' ').trim()).digest('hex');
export function createPrivateReportGuard({stateDir,atomicWrite=atomicUtilityJson,backup=backupOwnerFile,onError=()=>{}}={}) {
  let lastErrorAt=0;
  const file=path.join(stateDir,'private-report-guard.json');
  function read(){if(!fs.existsSync(file))return {version:1,entries:[]};let s;try{s=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('周记隔离存储损坏，已停止生成/发送');}
    if(s?.version!==1||!Array.isArray(s.entries)||s.entries.some(e=>!e||!/^(private|group):[1-9]\d{0,11}$/.test(e.key)||!/^[a-f0-9]{64}$/.test(e.hash)||!Array.isArray(e.ids)||e.ids.some(v=>!/^[-\d]+$/.test(v))))throw Error('周记隔离存储损坏，已停止生成/发送');return s;}
  function remember(key,text,ids=[]) {
    const s=read(),digest=hash(text);let e=s.entries.find(v=>v.key===key&&v.hash===digest);
    if(!e){e={key,hash:digest,ids:[]};s.entries.push(e);}
    e.ids=[...new Set([...e.ids,...ids.map(String)])];if(s.entries.length>10000)throw Error('周记隔离记录已满，请先由管理员维护，不能丢弃历史隔离记录');
    backup(file);atomicWrite(file,s);
  }
  function blocks(key,id,text='') {
    if(String(text).includes(PRIVATE_REPORT_MARKER))return true;
    try {return read().entries.some(e=>(!key||e.key===key)&&(id!=null&&e.ids.includes(String(id))||text&&e.hash===hash(text)));}
    catch{if(Date.now()-lastErrorAt>60000){lastErrorAt=Date.now();onError('私有周记隔离状态无法读取，已阻止正文进入聊天；请核查备份');}return true;}
  }
  return {file,remember,blocks,read};
}
