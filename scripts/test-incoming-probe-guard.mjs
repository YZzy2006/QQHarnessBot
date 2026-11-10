import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {shouldIgnoreProbeMessage} from '../src/incoming-probe-guard.js';import {bridgeHarness} from './audit-bridge-harness.mjs';
test('明确测活格式、大小写、全角、零宽、@/引用及混合段均静默识别',()=>{
 for(const text of ['#sl','#SL','＃ｓｌ','#s\u200bl','/status','!ping','#help','#服务器状态','#sl。','#sl!','#sl\ufe0f','.status','#ver','#info','#test','/model','/models','/whoami','/unknown-probe','[#sl]','`#sl`','#sl 参数','你好\n#sl','[CQ:at,qq=123] #sl'])assert.equal(shouldIgnoreProbeMessage(text),true,text);
 assert.equal(shouldIgnoreProbeMessage([{type:'reply',data:{id:'77'}},{type:'at',data:{qq:'123'}},{type:'text',data:{text:'#'}},{type:'text',data:{text:'sl'}},{type:'image',data:{file:'fixture'}}]),true);
});
test('正常聊天、自然语言天气/提醒/定时任务、业务指令和说明文字保持',()=>{
 for(const text of ['明天八点提醒我交作业','每天早上九点告诉我天气','[天气][北京]','[提醒][明天9点][带伞]','[定时任务][每天9点][提醒我吃早饭]','还在吗','今天服务器状态怎么样？','这段教程里提到 #sl','明天提醒我检查服务器状态','#slime','https://example.com/status','帮我解释 /status 的意思','help me with homework','[查看帮助]','[状态]','[服务器]','[主机状态]','[机器状态]','[资源占用]','[备份状态]','[会话列表]','[命令]','[指令 1]','[指令][全部]','帮助','功能','状态','status','/reset-ctx','/role card','/qzone status','[#天气]'])assert.equal(shouldIgnoreProbeMessage(text),false,text);
});
test('真实入口：所有身份/私聊群聊/运行模式均零发送、零请求、零唤醒且不建会话',async t=>{
 const h=await bridgeHarness({config:{ownerQQ:12345,allow:{private:[12345,23456],groups:[34567]}}});t.after(()=>h.close());
 const prior={sessions:h.socialV2.conversations.size,sent:h.calls.sent.length,prompts:h.calls.prompts.length,http:h.calls.http.length};
 const request=h.bot.request;let requests=0;h.bot.request=async()=>{requests++;throw Error('probe must not make gateway requests');};
 for(const mode of ['reserved2','reserved','chat','closed-agent']) {h.setMode(mode);for(const user of [12345,23456,99999])for(const kind of ['private','group'])for(const text of ['#sl','/status','/unknown-probe','#sl。','#ping']) {
  await h.handleIncoming(kind,kind==='group'?34567:user,{user_id:user,self_id:88888,message_id:71,message:[{type:'reply',data:{id:'72'}},{type:'at',data:{qq:'88888'}},{type:'text',data:{text}}]},h.cfg);
 }}
 h.bot.request=request;assert.equal(requests,0);assert.equal(h.socialV2.conversations.size,prior.sessions);assert.equal(h.calls.sent.length,prior.sent);assert.equal(h.calls.prompts.length,prior.prompts);assert.equal(h.calls.http.length,prior.http);
});
test('真实入口管理员自然语言提醒仍落原提醒状态（隔离假发送）',async t=>{
 const h=await bridgeHarness({config:{ownerQQ:12345,allow:{private:[12345],groups:[34567]}}});t.after(()=>h.close());h.setMode('reserved2');
 await h.handleIncoming('private',12345,{user_id:12345,self_id:88888,message_id:123,message:[{type:'text',data:{text:'[提醒我][2小时后][带伞]'}}]},h.cfg);
 const rows=[...h.getReminders().values()].flat();assert.ok(rows.some(row=>String(row.text).includes('带伞')));assert.ok(h.calls.sent.length>0);
});

test('自然语言提醒正常进入会话上下文，而不是被测活策略丢弃',async t=>{
 const h=await bridgeHarness({config:{ownerQQ:12345,allow:{private:[12345],groups:[34567]}}});t.after(()=>h.close());h.setMode('reserved2');
 await h.handleIncoming('private',12345,{user_id:12345,self_id:88888,message_id:124,message:[{type:'text',data:{text:'明天早上9点提醒我带伞'}}]},h.cfg);
 const state=h.socialV2.conversations.get('private:12345');assert.ok(state);assert.ok([...state.unread,...state.recentMessages].some(row=>String(row.text||row.plain).includes('带伞')));
});

test('管理员普通文字/方括号管理指令仍走原处理器，探测无身份豁免',async t=>{
 const h=await bridgeHarness({globals:{performance:{now:(()=>{let clock=0;return()=>clock+=5000;})()}},config:{ownerQQ:12345,allow:{private:[12345],groups:[34567]},sendDelayMinMs:0,sendDelayMaxMs:0}});t.after(()=>h.close());h.setMode('reserved2');
 let seq=501;for(const text of ['[查看帮助]','[状态]','[服务器]','[命令]']){
  const before=h.calls.sent.length;await h.handleIncoming('private',12345,{user_id:12345,self_id:88888,message_id:seq++,message:[{type:'text',data:{text}}]},h.cfg);assert.ok(h.calls.sent.length>before,text);
 }
 const before=h.calls.sent.length;await h.handleIncoming('private',12345,{user_id:12345,self_id:88888,message_id:seq++,message:[{type:'text',data:{text:'#sl。'}}]},h.cfg);assert.equal(h.calls.sent.length,before);
});
