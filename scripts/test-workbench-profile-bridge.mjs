import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {setWorkbenchAccount} from '../src/workbench-auth.js';

async function setup(t) {
 const h=await bridgeHarness({globals:{fetch:(url,init)=>{if(!/^http:\/\/127\.0\.0\.1:\d+\/api\//.test(String(url)))throw Error('external call forbidden');return fetch(url,init);}}});
 fs.mkdirSync(path.join(h.temp,'public'),{recursive:true});fs.copyFileSync(path.join(process.cwd(),'public/workbench-controls.js'),path.join(h.temp,'public/workbench-controls.js'));
 h.setMode('reserved2');h.cfg.allow={private:[123],groups:[456]};h.cfg.deny={private:[],groups:[]};
 h.cfg.socialV2.voice={...h.cfg.socialV2.voice,ttsEnabled:true,defaultProfile:'soft',profiles:{soft:{label:'柔和',model:'test-tts',voice:'test-soft'},bright:{label:'明亮',model:'test-tts',voice:'test-bright'}}};
 fs.writeFileSync(path.join(h.temp,'config.json'),JSON.stringify({ownerQQ:123,allow:h.cfg.allow,deny:h.cfg.deny,socialV2:h.cfg.socialV2,unrelated:{preserved:true},consoleToken:'DO-NOT-EXPOSE-FIXTURE'}));
 await setWorkbenchAccount(path.join(h.temp,'state'),'fixture','profile-fixture-password');
 const server=h.startConsoleServer();await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();});
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function req(route,body,extra={}){const r=await fetch(base+'/api/workbench/'+route,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin:base,'x-workbench-csrf':csrf}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,headers:r.headers,data:await r.json()};}
 const login=await req('login',{username:'fixture',password:'profile-fixture-password'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
 const profile=async()=>(await req('view?tab=profile')).data.data;
 async function action(body){const requestId=crypto.randomUUID(),r=await req('action',{...body,requestId});assert.equal(r.status,202);for(let i=0;i<100;i++){const j=(await req('job?id='+requestId)).data.job;if(j.status!=='running')return j;await new Promise(r=>setTimeout(r,5));}throw Error('job timeout');}
 return {h,req,profile,action,base};
}
test('真实桥接档案GET不创建会话、不改文件、不调用模型，配置与凭据分离，代理通道不可读取',async t=>{
 const f=await setup(t),count=f.h.socialV2.conversations.size,file=fs.readFileSync(path.join(f.h.temp,'config.json'),'utf8');
 const data=await f.profile();assert.equal(data.voices.length,2);assert.equal(f.h.socialV2.conversations.size,count);assert.equal(fs.readFileSync(path.join(f.h.temp,'config.json'),'utf8'),file);
 assert.doesNotMatch(JSON.stringify(data),/DO-NOT-EXPOSE|fixture-console-token|authToken|apiKey/);assert.equal((await f.req('view?tab=profile',null,{'x-agent-call':'1'})).status,403);
 assert.equal((await fetch(f.base+'/api/workbench/view?tab=profile')).status,401);assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
 const controls=await fetch(f.base+'/workbench-controls.js');assert.equal(controls.status,200);assert.match(controls.headers.get('content-type'),/text\/javascript/);
});
test('真实桥接配置改到原config与会话状态，停用保留记录/白名单，启用恢复范围，声线和主动按会话隔离',async t=>{
 const f=await setup(t);let p=await f.profile();let row=p.scopes.find(r=>r.key==='group:456');
 assert.equal((await f.action({action:'scope.proactive',key:row.key,revision:row.revision,enabled:false})).status,'succeeded');assert.equal(f.h.socialV2.conversations.get('group:456').proactiveGreetingEnabled,false);
 p=await f.profile();row=p.scopes.find(r=>r.key==='group:456');assert.equal((await f.action({action:'scope.voice',key:row.key,revision:row.revision,profile:'bright'})).status,'succeeded');assert.equal(f.h.socialV2.conversations.get('group:456').voiceProfile,'bright');
 p=await f.profile();row=p.scopes.find(r=>r.key==='group:456');assert.equal((await f.action({action:'scope.enabled',key:row.key,revision:row.revision,enabled:false})).status,'succeeded');assert.deepEqual([...f.h.cfg.allow.groups],[456]);assert.deepEqual([...f.h.cfg.deny.groups],[456]);assert.equal((await f.req('view?tab=memory&scope=group:456')).status,403);
 p=await f.profile();row=p.scopes.find(r=>r.key==='group:456');assert.equal(row.enabled,false);assert.equal((await f.action({action:'scope.enabled',key:row.key,revision:row.revision,enabled:true})).status,'succeeded');assert.equal((await f.req('view?tab=memory&scope=group:456')).status,200);assert.equal(f.h.socialV2.conversations.get('group:456').voiceProfile,'bright');
 p=await f.profile();assert.equal((await f.action({action:'capability.toggle',id:'voice',enabled:false,revision:p.revision})).status,'succeeded');const config=JSON.parse(fs.readFileSync(path.join(f.h.temp,'config.json'),'utf8'));assert.equal(config.socialV2.voice.ttsEnabled,false);assert.equal(config.unrelated.preserved,true);assert.equal(f.h.cfg.socialV2.voice.ttsEnabled,false);
 const owner=(await f.profile()).scopes.find(r=>r.owner);assert.equal((await f.action({action:'scope.enabled',key:owner.key,revision:owner.revision,enabled:false})).status,'failed');assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});

test('真实桥接兼容单数group白名单，停用后从范围移除；写盘失败以失败结果回退会话字段',async t=>{
 const f=await setup(t);f.h.cfg.allow={private:[123],group:[456]};f.h.cfg.deny={private:[],group:[]};
 const configFile=path.join(f.h.temp,'config.json'),saved=JSON.parse(fs.readFileSync(configFile,'utf8'));saved.allow=f.h.cfg.allow;saved.deny=f.h.cfg.deny;fs.writeFileSync(configFile,JSON.stringify(saved));
 assert.ok((await f.req('view?tab=overview')).data.data.scopes.includes('group:456'));
 let row=(await f.profile()).scopes.find(r=>r.key==='group:456');assert.equal((await f.action({action:'scope.enabled',key:row.key,revision:row.revision,enabled:false})).status,'succeeded');
 assert.deepEqual([...f.h.cfg.deny.group],[456]);assert.equal((await f.req('view?tab=memory&scope=group:456')).status,403);
 row=(await f.profile()).scopes.find(r=>r.key==='group:456');await f.action({action:'scope.enabled',key:row.key,revision:row.revision,enabled:true});
 row=(await f.profile()).scopes.find(r=>r.key==='group:456');await f.action({action:'scope.proactive',key:row.key,revision:row.revision,enabled:true});
 const stateFile=path.join(f.h.temp,'state/social-v2.json');fs.renameSync(stateFile,stateFile+'.saved');fs.mkdirSync(stateFile);
 row=(await f.profile()).scopes.find(r=>r.key==='group:456');const job=await f.action({action:'scope.proactive',key:row.key,revision:row.revision,enabled:false});assert.equal(job.status,'failed');assert.equal(f.h.socialV2.conversations.get('group:456').proactiveGreetingEnabled,true);
 assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});

test('档案主动对话走正确原指令解析器，按目标会话把意图交给AI而非逐字发QQ',async t=>{
 const f=await setup(t);f.h.getSocialV2State('private:123').impression='私聊秘密不得串到群里';
 const job=await f.action({action:'conversation.talk',key:'group:456',text:'问问今天他心情怎么样'});
 assert.equal(job.status,'succeeded',job.error);assert.ok(f.h.calls.prompts.length>0);
 const prompt=f.h.calls.prompts.map(row=>(row.content||[]).map(item=>item.text||'').join('')).join('\n');
 assert.match(prompt,/group:456/);assert.match(prompt,/问问今天他心情怎么样/);assert.match(prompt,/行动安排而不是待发送原文/);assert.match(prompt,/会话已有的记忆/);assert.match(prompt,/当前人设/);assert.doesNotMatch(prompt,/私聊秘密不得串到群里/);
 assert.equal(f.h.calls.sent.length,0);assert.ok(job.result.messages.length>0);
});
test('主动对话拒绝越界目标和超过原业务500字限制，失败不投递模型',async t=>{
 const f=await setup(t);
 assert.equal((await f.action({action:'conversation.talk',key:'group:999',text:'关心一下'})).status,'failed');
 assert.equal((await f.action({action:'conversation.talk',key:'group:456',text:'字'.repeat(501)})).status,'failed');
 assert.equal(f.h.calls.prompts.length,0);assert.equal(f.h.calls.sent.length,0);
});

test('真实HTTP两个页面共用视频开关和独立限额；无真人发送/模型调用',async t=>{
 const f=await setup(t),key='group:456';let row=(await f.profile()).scopes.find(r=>r.key===key);
 assert.equal(row.video.available,true);assert.equal(row.video.effectiveLimit,3);
 assert.equal((await f.action({action:'scope.video',key,revision:row.revision,enabled:true})).status,'succeeded');
 let video=(await f.req('view?tab=videos&scope=all')).data.data.videoScopes.find(r=>r.key===key);assert.equal(video.video.enabled,true);
 assert.equal((await f.action({action:'scope.video-limit',key,revision:video.revision,dailyLimit:0})).status,'succeeded');
 row=(await f.profile()).scopes.find(r=>r.key===key);assert.equal(row.video.effectiveLimit,0);assert.match(row.video.status,/暂停/);
 const saved=JSON.parse(fs.readFileSync(path.join(f.h.temp,'state/bilibili/control.json'),'utf8'));assert.equal(saved.targets[key].dailyLimit,0);assert.equal(saved.targets[key].manualSelect,true);
 assert.equal((await f.action({action:'scope.video',key,revision:row.revision,enabled:false})).status,'succeeded');assert.equal(f.h.calls.sent.length,0);assert.equal(f.h.calls.prompts.length,0);
});
