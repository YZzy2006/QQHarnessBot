import {test} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import crypto from 'node:crypto';import fs from 'node:fs';import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';import {setWorkbenchAccount} from '../src/workbench-auth.js';import {createWorkbenchStore} from '../src/workbench-store.js';import {activityRecord} from '../src/workbench-records.js';
async function setup(t){
 const network=[];
 const h=await bridgeHarness({config:{dsh:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'}},files:{'state/.deepseek-key':'fixture-only'},globals:{fetch:(url,init)=>{
  if(/^http:\/\/127\.0\.0\.1:\d+\/api\//.test(String(url)))return fetch(url,init);
  network.push({url:String(url),body:init?.body?JSON.parse(init.body):null});
  if(String(url)==='https://api.deepseek.com/user/balance')return Promise.resolve(Response.json({is_available:true,balance_infos:[{currency:'CNY',total_balance:'19.23',granted_balance:'0.00',topped_up_balance:'19.23'}]}));
  if(String(url)==='https://api.deepseek.com/chat/completions')return Promise.resolve(Response.json({choices:[{finish_reason:'stop',message:{content:'今天听见了新的旋律，想把这份轻快记在纸页上。'}}]}));
  throw Error('external forbidden');
 }}});
 h.setMode('reserved2');await setWorkbenchAccount(path.join(h.temp,'state'),'fixture','record-fixture-password');
 const server=h.startConsoleServer();await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();});
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function req(route,body){const r=await fetch(base+'/api/workbench/'+route,{method:body?'POST':'GET',headers:{cookie,...(body?{origin:base,'content-type':'application/json','x-workbench-csrf':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,headers:r.headers,body:await r.json()};}
 const login=await req('login',{username:'fixture',password:'record-fixture-password'});cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.body.csrf;
 async function action(body){const id=crypto.randomUUID();assert.equal((await req('action',{...body,requestId:id})).status,202);for(let n=0;n<200;n++){const job=(await req('job?id='+id)).body.job;if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,5));}throw Error('timeout');}
 const ok=async body=>{const j=await action(body);assert.equal(j.status,'succeeded',j.error);return j;};
 const list=async kind=>(await req('view?tab=memory&kind='+kind)).body.data.listing.items;
 return {h,req,action,ok,list,network};
}
test('真实桥接编辑待办/截图待办/引用回忆：旧版本拒绝，原引用保留，不发QQ',async t=>{
 const f=await setup(t);await f.ok({action:'note.add',text:'原待办'});let row=(await f.list('note'))[0];
 const update={action:'record.edit',kind:'note',id:row.id,revision:row.revision,text:'新版待办'};await f.ok(update);assert.equal(f.h.ownerTools.readOwner().notes[0].text,'新版待办');assert.equal((await f.action({...update,text:'覆盖'})).status,'failed');
 f.h.utilities.store.editProfile('123',p=>p.todos.push({id:'t_123456789abc',text:'截图待办',done:false,createdAt:Date.now(),dueAt:0}));row=(await f.list('todo'))[0];await f.ok({action:'record.edit',kind:'todo',id:row.id,revision:row.revision,text:'截图更正'});assert.equal(f.h.utilities.store.profile('123').todos[0].text,'截图更正');
 f.h.companion.change(p=>p.memories.push({id:'m_123456789abc',text:'原始引用',createdAt:Date.now(),correction:''}));row=(await f.list('saved'))[0];await f.ok({action:'record.edit',kind:'saved',id:row.id,revision:row.revision,text:'更正说明'});const saved=f.h.companion.profile().memories[0];assert.equal(saved.text,'原始引用');assert.equal(saved.correction,'更正说明');
 assert.equal(f.h.calls.sent.length,0);assert.equal(f.network.length,0);
});
test('真实会话记忆逐条修改与旧版本拒绝；任务内容和执行时间可改',async t=>{
 const f=await setup(t);await f.ok({action:'memory.append',key:'group:456',text:'音乐'});let row=(await f.list('conversation')).find(r=>r.text==='音乐');
 const update={action:'memory.update',key:row.key,category:row.category,original:row.text,target:'',revision:row.revision,text:'爵士乐'};await f.ok(update);assert.equal((await f.action(update)).status,'failed');assert.equal(f.h.getSocialV2State('group:456').activeTopics[0].text,'爵士乐');
 await f.ok({action:'reminder.create',when:'30分钟后',text:'提醒休息'});row=(await f.list('task'))[0];const before=row.at;
 await f.ok({action:'task.edit',key:row.key,id:row.id,revision:row.revision,field:'text',text:'新的提醒'});assert.equal((await f.action({action:'task.edit',key:row.key,id:row.id,revision:row.revision,field:'text',text:'旧页覆盖'})).status,'failed');
 row=(await f.list('task'))[0];await f.ok({action:'task.edit',key:row.key,id:row.id,revision:row.revision,field:'when',text:'60分钟后'});assert.ok(f.h.getReminders().get(row.key)[0].at>before);
 assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});
test('全局日记按需生成且当天复用，私人隔离，余额缓存返回必要字段',async t=>{
 const f=await setup(t),store=createWorkbenchStore({stateDir:path.join(f.h.temp,'state')});
 assert.equal((await f.action({action:'diary.generate'})).status,'failed');assert.equal(f.network.length,0);
 store.activity(activityRecord('private:123 [reserved2] AI 内部输出：今天发现了一首喜欢的歌',{at:Date.now()}));
 await f.ok({action:'diary.generate'});await f.ok({action:'diary.generate'});const records=store.read().diaries;
 assert.equal(records.length,1);assert.equal(records[0].source,'diary-generator');assert.ok(f.h.privateReportGuard.blocks('',null,records[0].text));assert.equal(f.network.length,1);assert.equal(f.network[0].body.tools,undefined);assert.match(f.network[0].body.messages[0].content,/kind=diary/);
 assert.equal((await f.req('view?tab=diaries&scope=group:456')).body.data.entries.length,0);
 let balance=(await f.req('view?tab=balance')).body.data;assert.equal(balance.rows[0].total,'19.23');await f.ok({action:'balance.refresh'});assert.equal(f.network.filter(r=>r.url.endsWith('/user/balance')).length,1);assert.doesNotMatch(JSON.stringify(balance),/fixture-only|Authorization|Bearer/);
 assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});
