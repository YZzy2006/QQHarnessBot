import fs from 'node:fs';
import path from 'node:path';
import {atomicUtilityJson} from './utility-store.js';
import {backupOwnerFile} from './owner-tools.js';
import {monitorUrl} from './practical-data.js';
export function createPracticalStore({stateDir,atomicWrite=atomicUtilityJson,backup=backupOwnerFile}) {
  const file=path.join(stateDir,'practical.json');
  function validate(s){
    if(s?.version!==1||!Array.isArray(s.events)||s.events.length>1000||!Array.isArray(s.watches)||s.watches.length>64||JSON.stringify(s).length>1000000)throw Error('实用功能存储损坏或容量已满，停止读写');
    const ids=new Set();
    for(const row of [...s.events,...s.watches]){
      if(!row||!/^z_[a-f0-9]{12}$/.test(row.id)||ids.has(row.id)||!/^[1-9]\d{0,11}$/.test(row.owner)||!Number.isFinite(row.createdAt))throw Error('实用功能记录标识损坏');ids.add(row.id);
    }
    for(const e of s.events)if(typeof e.title!=='string'||!e.title||e.title.length>100||typeof e.location!=='string'||e.location.length>200||!Number.isFinite(e.at)||!Number.isFinite(e.end)||e.end<e.at||!Number.isFinite(e.notifyAt)||e.notifyAt>e.at||!Number.isFinite(e.until)||e.until<e.at||!/^[a-f0-9]{64}$/.test(e.fingerprint)||e.delivery!=null&&!['sending','sent','unknown','expired'].includes(e.delivery))throw Error('日历记录损坏');
    for(const e of s.events)if(e.batchId!=null&&!/^b_[a-f0-9]{12}$/.test(e.batchId))throw Error('日历批次标识损坏');
    for(const w of s.watches){
      if(w.lastCheckedAt!=null&&!Number.isFinite(w.lastCheckedAt)||w.lastError!=null&&(typeof w.lastError!=='string'||w.lastError.length>100)||w.excerpt!=null&&(typeof w.excerpt!=='string'||w.excerpt.length>240))throw Error('订阅检查状态损坏');
      if(!['feed','page','health'].includes(w.kind)||typeof w.url!=='string'||monitorUrl(w.url)!==w.url||w.url.length>1000||!Number.isInteger(w.interval)||w.interval<300000||w.interval>86400000||!Number.isFinite(w.nextAt)||!Number.isInteger(w.failures)||w.failures<0||!['unknown','up','down'].includes(w.health)||!Array.isArray(w.seen)||w.seen.length>500||w.seen.some(v=>!/^[a-f0-9]{64}$/.test(v))||w.kind==='page'&&(typeof w.keyword!=='string'||w.keyword.length>50)||w.pending!=null&&(!/^[a-f0-9]{64}$/.test(w.pending.id)||typeof w.pending.text!=='string'||w.pending.text.length>4000||!['ready','sending','unknown'].includes(w.pending.state)))throw Error('订阅记录损坏');
    }
    return s;
  }
  const read=()=>{if(!fs.existsSync(file))return {version:1,events:[],watches:[]};try{return validate(JSON.parse(fs.readFileSync(file,'utf8')));}catch{throw Error('实用功能存储损坏，已停止读写');}};
  const change=fn=>{const s=read(),out=fn(s);if(out?.then)throw Error('存储修改必须同步');validate(s);backup(file);atomicWrite(file,s);return out;};
  return {file,read,change};
}
