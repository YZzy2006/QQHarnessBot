import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {createWorkbenchErrorReporter} from '../src/operational-errors.js';
import {shouldIgnoreProbeMessage} from '../src/incoming-probe-guard.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
test('工作台报错先脱敏、有限长度、去重；写盘失败不触发QQ兜底',()=>{
 let at=1000;const rows=[],reporter=createWorkbenchErrorReporter({append:r=>rows.push(r),ownerKey:()=> 'private:12345',redact:v=>v.replaceAll('fixture-credential','[redacted]'),now:()=>at});
 assert.equal(reporter.record('agent','group:34567','upstream fixture-credential'),true);assert.equal(reporter.record('agent','group:34567','upstream fixture-credential'),false);assert.equal(rows.length,1);assert.equal(rows[0].key,'private:12345');assert.equal(rows[0].sourceKey,'group:34567');assert.equal(rows[0].source,'system');assert.doesNotMatch(rows[0].message,/fixture-credential/);
 at+=300001;assert.equal(reporter.record('agent','group:34567','upstream fixture-credential'),true);reporter.record('long','', 'x'.repeat(50000));assert.ok(rows.at(-1).message.length<1800);
 const failed=createWorkbenchErrorReporter({append:()=>{throw Error('disk');},ownerKey:()=> 'private:12345'});assert.equal(failed.record('agent','', 'error'),false);
});
test('已配置工作台才关闭对应文字管理入口；天气/提醒/任务不受影响',()=>{
 for(const text of ['[状态]','[主机状态]','[资源占用]','[查看帮助]','[命令]','[指令 1]','[指令][全部]','[备份状态]','[最近错误]','[会话列表]','[今日用量]','[余额]','[状态][随便]','/role card','/qzone status','/reset-ctx']){
  assert.equal(shouldIgnoreProbeMessage(text,{workbenchAvailable:true}),true,text);assert.equal(shouldIgnoreProbeMessage(text),false,text);
 }
 for(const text of ['明天9点提醒我带伞','每天早上告诉我天气','[天气][北京]','[提醒我][2小时后][带伞]','[定时任务][每天9点][提醒我吃药]','[提醒列表]'])assert.equal(shouldIgnoreProbeMessage(text,{workbenchAvailable:true}),false,text);
});
test('系统错误、回合失败、任务失败、watchdog都进工作台，任何模式零QQ通知',async t=>{
 const h=await bridgeHarness({config:{ownerQQ:12345,allow:{private:[12345],groups:[34567]}}});t.after(()=>h.close());const sent=h.calls.sent.length;
 for(const mode of ['reserved2','reserved','chat','closed-agent']){h.setMode(mode);await h.reportTurnFailure('group:34567','error',new Error('fixture upstream '+mode));await h.notifyOwnerTaskFailure('group:34567',{id:'r_fixture',text:'正常任务'},'fixture task '+mode);await h.notifyOwnerWatchdog('fixture stalled '+mode);}
 const rows=JSON.parse(fs.readFileSync(path.join(h.temp,'state/feedback.json'),'utf8'));for(const kind of ['agent','scheduled-task','watchdog'])assert.ok(rows.some(row=>row.systemKind===kind),kind);assert.equal(h.calls.sent.length,sent);assert.equal(h.calls.prompts.length,0);assert.ok(rows.every(row=>row.source==='system'));
});
test('工作台启用后QQ管理入口静默，不展开引用或取成员；正常提醒照常创建',async t=>{
 const h=await bridgeHarness({config:{ownerQQ:12345,allow:{private:[12345,23456],groups:[34567]}}});t.after(()=>h.close());h.setMode('reserved2');h.cfg.workbench.origin='https://workbench.example.test';
 const request=h.bot.request;h.bot.request=async()=>{throw Error('must not resolve a blocked QQ command');};let sequence=600;
 for(const user of [12345,23456])for(const kind of ['private','group'])for(const text of ['[查看帮助]','[服务器]','[备份状态]','[最近错误]'])await h.handleIncoming(kind,kind==='private'?user:34567,{user_id:user,self_id:88888,message_id:sequence++,message:[{type:'reply',data:{id:'123'}},{type:'text',data:{text}}]},h.cfg);
 assert.equal(h.calls.sent.length,0);assert.equal(h.calls.prompts.length,0);assert.equal(h.socialV2.conversations.size,0);h.bot.request=request;
 await h.handleIncoming('private',12345,{user_id:12345,self_id:88888,message_id:sequence++,message:[{type:'text',data:{text:'[提醒我][2小时后][带伞]'}}]},h.cfg);assert.ok([...h.getReminders().values()].flat().some(row=>String(row.text).includes('带伞')));
});

test('报错洪峰按分钟限频，原服务日志继续保留但不刷工作台存储',()=>{
 const rows=[],reporter=createWorkbenchErrorReporter({append:r=>rows.push(r),ownerKey:()=> 'private:12345',now:()=>10000});
 for(let i=0;i<1000;i++)reporter.record('runtime','', 'unique fixture error '+i);assert.equal(rows.length,20);
});
