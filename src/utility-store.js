import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {backupOwnerFile} from './owner-tools.js';
export const utilityId=(prefix)=>prefix+'_'+crypto.randomBytes(6).toString('hex');
export const utilityText=(v,max=1000)=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max);
export function atomicUtilityJson(file,data) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp-'+crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'}); fs.renameSync(tmp,file); }
  finally { if(fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function createUtilityStore({stateDir,atomicWrite=atomicUtilityJson,backup=backupOwnerFile}={}) {
  const file=path.join(stateDir,'utilities.json');
  const newProfile=()=>({city:'',detail:'详细',quietStart:22,quietEnd:8,todos:[],topics:[],subscriptions:{},deliveries:{}});
  const blank=()=>({version:1,profiles:{},groups:{},owners:{}});
  function validate(s) {
    if(s?.version!==1||!['profiles','groups','owners'].every(k=>s[k]&&typeof s[k]==='object'&&!Array.isArray(s[k]))) throw Error('扩展存储损坏，已停止读写');
    for(const key of Object.keys(s.profiles)) {
      const p=s.profiles[key];
      if(!/^[1-9]\d{0,11}$/.test(key)||!p||typeof p.city!=='string'||p.city.length>80||!['详细','简洁'].includes(p.detail)
        ||![p.quietStart,p.quietEnd].every(v=>Number.isInteger(v)&&v>=0&&v<=23)||!Array.isArray(p.todos)||p.todos.length>200
        ||p.todos.some(t=>!/^t_[a-f0-9]{12}$/.test(t.id)||typeof t.text!=='string'||!t.text||t.text.length>500||!Number.isFinite(t.createdAt)||!Number.isFinite(t.dueAt??0)||(t.dueAt??0)<0)
        ||!Array.isArray(p.topics)||p.topics.length>5||p.topics.some(v=>typeof v!=='string'||!v||v.length>20)
        ||!p.subscriptions||typeof p.subscriptions!=='object'||Array.isArray(p.subscriptions)||!p.deliveries||typeof p.deliveries!=='object'||Array.isArray(p.deliveries)) throw Error('个人设置格式错误');
      for(const [kind,sub] of Object.entries(p.subscriptions)) if(!['daily','weekly','news'].includes(kind)||!sub||!Number.isFinite(sub.createdAt)||!Number.isInteger(sub.hour)||sub.hour<0||sub.hour>23||!Number.isInteger(sub.minute)||sub.minute<0||sub.minute>59||sub.day!=null&&(!Number.isInteger(sub.day)||sub.day<0||sub.day>6)) throw Error('订阅格式错误');
    }
    for(const [key,g] of Object.entries(s.groups)) {
      if(!/^(group|private):[1-9]\d{0,11}$/.test(key)||!g||!Array.isArray(g.knowledge)||g.knowledge.length>200||!Array.isArray(g.media)||g.media.length>200) throw Error('群资料格式错误');
      for(const k of g.knowledge) if(!/^k_[a-f0-9]{12}$/.test(k.id)||typeof k.title!=='string'||typeof k.text!=='string'||k.text.length>6000||!['pending','approved','expired'].includes(k.status)||!Number.isFinite(k.createdAt)) throw Error('群知识格式错误');
      for(const m of g.media) if(!/^s_[a-f0-9]{12}$/.test(m.id)||!['song','movie'].includes(m.kind)||typeof m.title!=='string'||typeof m.url!=='string'||!Array.isArray(m.reviews)||m.reviews.length>50||m.reviews.some(v=>typeof v.text!=='string'||v.text.length>300||!/^[1-9]\d{0,11}$/.test(v.author)||!Number.isFinite(v.at))) throw Error('歌单片单格式错误');
    }
    for(const [key,o] of Object.entries(s.owners)) {
      if(!/^[1-9]\d{0,11}$/.test(key)||!o||!Array.isArray(o.errors)||o.errors.length>200||!Array.isArray(o.drafts)||o.drafts.length>100) throw Error('管理员资料格式错误');
      for(const e of o.errors) if(!/^e_[a-f0-9]{12}$/.test(e.id)||!['title','symptom','cause','solution'].every(k=>typeof e[k]==='string')||!Number.isFinite(e.createdAt)) throw Error('报错档案格式错误');
      for(const a of o.drafts) if(!/^a_[a-f0-9]{12}$/.test(a.id)||typeof a.text!=='string'||a.text.length>6000||!Number.isFinite(a.createdAt)) throw Error('公告草稿格式错误');
    }
    if(JSON.stringify(s).length>2_000_000) throw Error('扩展存储容量已满，请先整理');
    return s;
  }
  function read(){if(!fs.existsSync(file))return blank();let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('扩展存储损坏或无法读取，已停止读写');}return validate(data);}
  function change(fn){const s=read();const result=fn(s);if(result?.then)throw Error('状态修改必须同步');validate(s);backup(file);atomicWrite(file,s);return result;}
  const profile=(uid,s=read())=>s.profiles[String(uid)]||newProfile();
  const group=(key,s=read())=>s.groups[key]||{knowledge:[],media:[]};
  const owner=(uid,s=read())=>s.owners[String(uid)]||{errors:[],drafts:[]};
  function editProfile(uid,fn){return change(s=>{const p=profile(uid,s);const r=fn(p);s.profiles[String(uid)]=p;return r;});}
  function editGroup(key,fn){return change(s=>{const g=group(key,s);const r=fn(g);s.groups[key]=g;return r;});}
  function editOwner(uid,fn){return change(s=>{const o=owner(uid,s);const r=fn(o);s.owners[String(uid)]=o;return r;});}
  return {file,read,change,profile,group,owner,editProfile,editGroup,editOwner,newProfile};
}
