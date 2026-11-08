import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageRecords,activityRecord,memoryRecords,recordRevision} from '../src/workbench-records.js';
import {createWorkbenchServer} from '../src/workbench-server.js';
import {createWorkbenchStore} from '../src/workbench-store.js';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const params=value=>new URLSearchParams(value);
test('北京时间日界、关键词/分类/状态先过滤再分页，越界页归末页',()=>{
 const rows=Array.from({length:35},(_,n)=>({id:String(n),at:Date.parse('2026-11-06T16:00:00Z')+n*1000,kind:n%2?'private':'reflection',text:'心情',decision:{status:'open'}}));
 rows.push({id:'old',at:Date.parse('2026-11-06T15:59:59Z'),kind:'reflection',text:'心情'},{id:'unknown',at:0,kind:'reflection',text:'心情'});
 const query=params({from:'2026-11-07',to:'2026-11-07',kind:'reflection',q:'心情',state:'open',page:'2',size:'6'});
 let list=pageRecords(rows,query);assert.equal(list.total,18);assert.equal(list.items.length,6);assert.equal(list.page,2);assert.equal(list.pages,3);
 query.set('page','99');assert.equal(pageRecords(rows,query).page,3);
 for(const from of ['2026-02-30','2026-13-01','a'])assert.throws(()=>pageRecords(rows,params({from})),/日期/);
 for(const size of ['0','1000','NaN'])assert.throws(()=>pageRecords(rows,params({size})),/分页/);
 assert.equal(pageRecords(rows,params({q:'不存在',page:'4'})).page,1);
});
test('只收录角色表达和真实行动，技术流水丢弃，旧时钟不猜日期',()=>{
 const long='今天想听一首新的歌。'.repeat(50),r=activityRecord('[09:47:00] private:123 [reserved2] AI 内部输出：'+long);
 assert.equal(r.kind,'reflection');assert.equal(r.at,0);assert.equal(r.notSent,true);assert.equal(r.text,long);assert.doesNotMatch(r.title+r.text,/reserved2/);
 assert.equal(activityRecord('[11:20:00] private:123 [reserved2] 消息已入未读：?'),null);
 assert.equal(activityRecord('private:123 agent 回复：今天好吗').kind,'private');
 assert.equal(activityRecord('group:456 [reserved2] 工具分条发送：成功 2/2 条'),null);assert.equal(activityRecord('group:456 [message] agent 回复：好久不见').kind,'group');
 assert.equal(activityRecord('[2026-11-07T03:00:00.000Z] [QQ空间] 说说发布成功').kind,'qzone');
 assert.ok(activityRecord('[2026-11-07T03:00:00.000Z] private:123 agent 回复：你好').at>0);
});
test('结构化记忆可编辑版本来自原始条目；活动持久化有界并与日记分离',()=>{
 const original={text:'喜欢音乐',createdAt:123},rows=memoryRecords({notes:[{id:'n_1100100004',text:'原待办'}],conversations:[{key:'private:123',raw:{activeTopics:[original],memberImpressions:{小雨:{traits:['耐心'],lastSeenAt:123}}}}]});
 assert.equal(rows.find(r=>r.category==='activeTopic').revision,recordRevision(original));assert.equal(rows.find(r=>r.target==='小雨').text,'耐心');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'record-test-'));try{const store=createWorkbenchStore({stateDir:dir});store.activity(activityRecord('private:123 [reserved2] AI 内部输出：想起今天的歌',{at:Date.now()}));assert.equal(store.read().activities.length,1);assert.equal(store.read().diaries.length,0);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
function monitor({low=false,high=false,fail=false}={}){
 let time=1_800_000_000_000,reads=0,calls=[];
 const app=createWorkbenchServer({now:()=>time,read:()=>{reads++;return `MemTotal: 4000000 kB\nMemAvailable: ${low?1000:1000000} kB\nSwapTotal: 500000 kB\nSwapFree: 400000 kB`;},statfs:()=>({blocks:100,bsize:1024,bfree:high?10:30,bavail:high?10:30}),loads:()=>[0.1,0.2,0.3],cpus:()=>4,uptime:()=>1000,services:async()=>['active','active'],maintenance:async mode=>{calls.push(mode);return {mode,dryRun:mode==='preview',before:{usedPercent:90},after:{usedPercent:80,availableBytes:2048,totalBytes:4096},scratch:{eligibleDirs:1,eligibleBytes:512,plan:[{name:'dsh-workspace-changes-abc123',fingerprint:'a'.repeat(64)}]},partialFailure:fail};}});
 return {app,calls,reads:()=>reads,advance:ms=>time+=ms};
}
test('服务器读数有缓存、强制刷新冷却、告警阈值，不启动常驻任务',async()=>{
 const f=monitor({high:true});let data=await f.app.snapshot();assert.equal(data.alerts[0].kind,'disk');await f.app.snapshot();await f.app.snapshot(true);assert.equal(f.reads(),1);f.advance(11000);await f.app.snapshot(true);assert.equal(f.reads(),2);assert.equal(f.calls.length,0);
});
test('清理必须预览、凭证限时且单次消费，内存不足拒绝扫描，失败预览不开放删除',async()=>{
 const f=monitor();await assert.rejects(f.app.applyCleanup('arbitrary'),/预览/);assert.equal(f.calls.length,0);
 const p=await f.app.previewCleanup();await f.app.previewCleanup();assert.deepEqual(f.calls,['preview']);
 await assert.rejects(f.app.applyCleanup('wrong'),/预览/);await f.app.applyCleanup(p.preview.token);assert.deepEqual(f.calls,['preview','apply']);await assert.rejects(f.app.applyCleanup(p.preview.token),/预览/);
 const g=monitor();const q=await g.app.previewCleanup();g.advance(300001);await assert.rejects(g.app.applyCleanup(q.preview.token),/失效/);
 const low=monitor({low:true});await assert.rejects(low.app.previewCleanup(),/资源/);assert.equal(low.calls.length,0);
 await assert.rejects(monitor({fail:true}).app.previewCleanup(),/未完整/);
});
