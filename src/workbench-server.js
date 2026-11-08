import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runDiskMaintenance,formatDiskMaintenance} from './disk-maintenance.js';
const exec=promisify(execFile);
export function createWorkbenchServer({now=Date.now,read=fs.readFileSync,statfs=fs.statfsSync,cpus=()=>os.availableParallelism(),loads=()=>os.loadavg(),uptime=()=>os.uptime(),maintenance=runDiskMaintenance,services=async()=>{
  try{const {stdout}=await exec('/usr/bin/systemctl',['is-active','qq-bridge.service','dsh-web.service'],{timeout:3000,maxBuffer:4096,windowsHide:true});return stdout.trim().split('\n');}
  catch(e){return String(e.stdout||'unknown\nunknown').trim().split('\n');}
}}={}) {
  let cached=null,inflight=null,lastRefresh=0,lastClean=0,preview=null;
  function metrics(){
    const mem=Object.fromEntries(String(read('/proc/meminfo','utf8')).split('\n').map(line=>{const m=/^(\w+):\s+(\d+)/.exec(line);return m?[m[1],Number(m[2])*1024]:['',0];}));
    const d=statfs('/'),total=d.blocks*d.bsize,available=d.bavail*d.bsize,used=(d.blocks-d.bfree)*d.bsize;
    const memory={total:mem.MemTotal||0,available:mem.MemAvailable||0,swapTotal:mem.SwapTotal||0,swapFree:mem.SwapFree||0};
    const disk={total,available,used,percent:Math.ceil(100*used/Math.max(1,used+available))};
    const cpu={cores:cpus(),load:loads()};const alerts=[];
    if(memory.available<Math.max(256*1024**2,memory.total*.1))alerts.push({kind:'memory',text:'可用内存偏低，请减少并行任务；不会自动重启服务。'});
    if(disk.percent>=85)alerts.push({kind:'disk',text:'系统盘使用达到85%，建议先做安全清理预览。'});
    if(cpu.load[0]>cpu.cores*1.5)alerts.push({kind:'cpu',text:'近期系统负载偏高，请稍后执行维护。'});
    return {at:now(),memory,disk,cpu,uptime:uptime(),alerts};
  }
  async function snapshot(force=false){
    if(inflight)return inflight;
    if(cached&&(!force&&now()-cached.at<60000||force&&now()-lastRefresh<10000))return {...cached,cached:true};
    lastRefresh=now();inflight=(async()=>{const m=metrics(),states=await services();cached={...m,services:[{name:'QQ 机器人',state:states[0]||'unknown'},{name:'DSH',state:states[1]||'unknown'}]};return {...cached,cached:false};})();
    try{return await inflight;}finally{inflight=null;}
  }
  const publicPreview=()=>{const {plan,...publicPart}=preview;return publicPart;};
  async function previewCleanup(){
    const m=metrics();if(m.memory.available<256*1024**2||m.cpu.load[0]>m.cpu.cores*2)throw Error('服务器资源紧张，暂不运行清理扫描，请稍后重试');
    if(preview&&now()<preview.expiresAt)return {preview:publicPreview(),messages:[{text:preview.description}]};
    const result=await maintenance('preview');
    if(result.partialFailure||!Array.isArray(result.scratch?.plan)||result.scratch.plan.length>500)throw Error('清理预览未完整通过或清单过大，未开放删除');
    preview={token:crypto.randomUUID(),at:now(),expiresAt:now()+300000,description:formatDiskMaintenance(result),eligibleBytes:result.scratch?.eligibleBytes||0,plan:result.scratch.plan};
    return {preview:publicPreview(),messages:[{text:preview.description+'\n系统日志按已有7天/512MiB规则保留；只清理已审查范围。'}]};
  }
  async function applyCleanup(token){
    if(!preview||preview.token!==token||now()>=preview.expiresAt)throw Error('清理预览已失效，请重新预览');
    if(lastClean&&now()-lastClean<300000)throw Error('刚执行过清理，请等待5分钟再试');
    const m=metrics();if(m.memory.available<256*1024**2||m.cpu.load[0]>m.cpu.cores*2)throw Error('服务器资源紧张，已取消本次清理');
    const expectedPlan=preview.plan;preview=null;lastClean=now();const result=await maintenance('apply',{expectedPlan});cached=null;
    return {partialFailure:!!result.partialFailure,messages:[{text:formatDiskMaintenance(result)}],snapshot:await snapshot()};
  }
  return {snapshot,previewCleanup,applyCleanup};
}
