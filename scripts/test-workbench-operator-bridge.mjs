import {workbenchContext} from '../src/workbench-http.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {setWorkbenchAccount} from '../src/workbench-auth.js';

async function fixture(t) {
 const h=await bridgeHarness({config:{ownerQQ:12345,allow:{private:[12345,23456],groups:[34567]}},globals:{fetch:(url,init)=>{if(!/^http:\/\/127\.0\.0\.1:\d+\/api\//.test(String(url)))throw Error('external forbidden');return fetch(url,init);}}});
 h.setMode('reserved2');h.calls.qzoneFriends=[{user_id:23456,nickname:'测试联系人',remark:'小雨'},{user_id:45678,nickname:'同名好友'},{user_id:56789,nickname:'同名好友'}];
 h.calls.groups=[{group_id:34567,group_name:'读书群'}];h.calls.groupMembers=[{user_id:23456,nickname:'测试联系人',card:'书友小雨'}];
 await setWorkbenchAccount(path.join(h.temp,'state'),'fixture','operator-fixture-password');
 const server=h.startConsoleServer();await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await h.close();});
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function req(route,body,headers={}){const response=await fetch(base+'/api/workbench/'+route,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{origin:base,'content-type':'application/json','x-workbench-csrf':csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,headers:response.headers,data:await response.json()};}
 const login=await req('login',{username:'fixture',password:'operator-fixture-password'});cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
 async function run(commandId,args={},confirmed=true){const id=crypto.randomUUID();assert.equal((await req('action',{action:'command.run',requestId:id,commandId,args,confirmed})).status,202);for(let n=0;n<300;n++){const job=(await req('job?id='+id)).data.job;if(job.status!=='running')return job;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('timeout');}
 const ok=async(...args)=>{const job=await run(...args);assert.equal(job.status,'succeeded',job.error||JSON.stringify(job));return job;};
 return {h,base,req,run,ok};
}
test('联系人读取有名字/备注/群名且不发QQ；原13组返回结构化操作',async t=>{
 const f=await fixture(t),dir=await f.req('view?tab=contacts');assert.equal(dir.status,200);
 const rows=dir.data.data.entries;assert.equal(rows.find(r=>r.key==='private:23456').name,'小雨');assert.equal(rows.find(r=>r.key==='private:23456').nickname,'测试联系人');assert.equal(rows.filter(r=>r.name==='同名好友').length,2);
 assert.equal(rows.find(r=>r.key==='group:34567').name,'读书群');assert.equal((await f.req('view?tab=contacts',null,{'x-agent-call':'1'})).status,403);
 const book=(await f.req('view?tab=commands')).data.data;assert.equal(book.sections.length,13);assert.ok(book.sections.every(row=>row.operations.length>0));
 assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});
test('待办/任务/免打扰/别名执行原处理器，回执只在网页，结束后不截走QQ回复',async t=>{
 const f=await fixture(t);
 let job=await f.ok('tools.note',{content:'网页真实适配'});assert.match(job.result.messages[0].text,/已记下/);const note=f.h.ownerTools.readOwner().notes.at(-1);assert.equal(note.text,'网页真实适配');
 await f.ok('tools.note-done',{id:note.id});assert.equal(f.h.ownerTools.readOwner().notes.at(-1).done,true);
 await f.ok('tools.reminder',{when:'30分钟后',content:'提醒测试'});const reminder=f.h.getReminders().get('private:12345').at(-1);assert.equal(reminder.kind,'ownerMemo');
 await f.ok('tools.task-content',{id:reminder.id,value:'新的内容'});assert.equal(f.h.getReminders().get('private:12345').at(-1).text,'新的内容');
 await f.ok('tools.task-pause',{id:reminder.id});assert.equal(f.h.getReminders().get('private:12345').at(-1).paused,true);
 await f.ok('tools.task-resume',{id:reminder.id});assert.equal(f.h.getReminders().get('private:12345').at(-1).paused,false);
 await f.ok('tools.quiet',{target:'group:34567',duration:'2小时'});assert.ok(f.h.getSocialV2State('group:34567').proactiveQuietUntil>Date.now());
 await f.ok('tools.unquiet',{target:'group:34567'});assert.equal(f.h.getSocialV2State('group:34567').proactiveQuietUntil,0);
 await f.ok('tools.alias',{name:'小群',target:'group:34567'});assert.equal(f.h.ownerTools.readOwner().aliases.at(-1).key,'group:34567');
 const contacts=(await f.req('view?tab=contacts')).data.data.entries;assert.ok(contacts.find(r=>r.key==='group:34567').aliases.includes('小群'));
 await f.ok('task.cancel',{id:reminder.id});assert.ok(!(f.h.getReminders().get('private:12345')||[]).some(row=>row.id===reminder.id));
 assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
 await f.h.sendToQQ('private:12345','正常QQ回复不受影响');assert.equal(f.h.calls.sent.length,1);
});
test('白名单、QQ发送限额与名片点赞走原业务；危险管理必须确认',async t=>{
 const f=await fixture(t);
 await f.ok('allow.private.add',{target:'private:45678'});assert.ok(f.h.cfg.allow.private.map(String).includes('45678'));
 await f.ok('active.limit-set',{kind:'私聊',period:'每分钟',count:'22'});assert.equal(f.h.cfg.sendLimits.private.perMinute,22);
 await f.ok('profile.like',{friend:'private:23456',count:'2'});assert.equal(f.h.calls.profileLikes.length,1);
 assert.equal((await f.run('admin.kick',{group:'group:34567',member:'书友小雨'},false)).status,'failed');assert.equal(f.h.calls.kicks.length,0);
 await f.ok('admin.kick',{group:'group:34567',member:'书友小雨'});assert.equal(f.h.calls.kicks.at(-1).group_id,34567);assert.equal(f.h.calls.kicks.at(-1).user_id,23456);
 await f.ok('qzone.list');await f.ok('social.status');await f.ok('friend.requests');
 assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});
test('复杂聊天记录依用户要求合并转发到QQ，网页收到回执',async t=>{
 const f=await fixture(t);f.h.calls.friendHistory=[{message_id:1,time:Math.floor(Date.now()/1000),user_id:23456,sender:{user_id:23456,nickname:'小雨'},message:[{type:'text',data:{text:'隔离消息'}}],raw_message:'隔离消息'}];
 const job=await f.ok('friends.history',{friend:'private:23456',count:'20'});
 assert.equal(f.h.calls.privateForwards.length,1);assert.equal(f.h.calls.privateForwards[0].user_id,12345);assert.ok(job.result.messages.length>0);assert.equal(f.h.calls.prompts.length,0);
});
test('错误参数不执行、不报成功；role配置复用原受控API',async t=>{
 const f=await fixture(t);
 assert.equal((await f.run('admin.kick',{group:'group:34567',member:'x][退群'})).status,'failed');
 assert.equal((await f.run('active.talk',{target:'private:99999',content:'不该发送'})).status,'failed');
 assert.equal((await f.run('task.cancel',{id:'全部'})).status,'failed');
 assert.equal((await f.run('not-a-command',{})).status,'failed');
 await f.ok('session.silent',{mode:'silent'});const saved=JSON.parse(fs.readFileSync(path.join(f.h.temp,'state/current-role.json'),'utf8'));assert.equal(saved.mode,'silent');
 assert.equal(f.h.calls.kicks.length,0);assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});

test('网页命令结束后，继承异步上下文的延迟QQ发送仍正常发出',async t=>{
 const f=await fixture(t),capture={active:true,ownerReplyKey:'private:12345',messages:[],strict:true};
 let done;
 const pending=new Promise((resolve,reject)=>{done={resolve,reject};});
 workbenchContext.run(capture,()=>setTimeout(()=>f.h.sendToQQ('private:12345','延迟的原有通知').then(done.resolve,done.reject),10));
 capture.active=false;await pending;
 assert.equal(f.h.calls.sent.length,1);assert.equal(capture.messages.length,0);
});
