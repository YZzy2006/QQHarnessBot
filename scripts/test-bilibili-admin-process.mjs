import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import http from 'node:http';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=','base64');
async function fixture(){
 let analyses=0;const h=await bridgeHarness({config:{vision:{fallbackEnabled:true},allow:{private:['123'],groups:['456']}},files:{'dsh/agent-presets/qq-chat-v2/agent.cordis.yml':fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml',import.meta.url),'utf8'),'state/current-role.json':{role:'fixture-card',mode:'normal'},'roles/fixture-card.md':'唯一测试人物卡'},globals:{safeFetch:async()=>({url:'https://www.bilibili.com/video/BV1xx411c7mD',statusCode:200,body:'window.__playinfo__={"data":{"durl":[{"url":"https://example.com/a.mp4"}]}}'}),safeFetchMedia:async()=>({buffer:Buffer.from('fixture-video')}),withVideoEvidence:async(b,o,fn)=>fn({duration:20,frames:[{at:0,buffer:png}],coverage:'受限采样'}),analyzeVideoEvidence:async()=>{analyses++;return'可见的测试画面事实';}}});
 h.setMode('reserved2');const key='group:456';const st=h.getSocialV2State(key);st.bootstrapSent=true;st.proactiveGreetingEnabled=false;
 h.appendSocialV2Message(key,'原发送者','https://www.bilibili.com/video/BV1xx411c7mD','原视频',false,false,'77',[],'234');
 for(const m of [...st.recentMessages,...st.unread])m.time-=30*60000;
 const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
 const post=(body,agent=false)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/socialV2/video-process',method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json',...(agent==='marker'?{'x-agent-call':'1'}:agent?{'x-agent-token':st.agentToken}:{})}},res=>{let s='';res.on('data',d=>s+=d);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(s)}));});req.on('error',reject);req.end(JSON.stringify(body));});
 return{h,st,key,post,analyses:()=>analyses,close:async()=>{await new Promise(r=>server.close(r));await h.close();}};
}
test('管理员处理真实已存在的群分享，保留原消息身份和时间、原未读，旧消息得到采样资料',async()=>{
 const f=await fixture();try{const original=f.st.recentMessages[0].time;const r=await f.post({key:f.key,messageId:'77'});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.ok,true);assert.equal(f.analyses(),1);assert.equal(f.st.recentMessages.filter(m=>String(m.messageId)==='77').length,1);assert.equal(f.st.recentMessages[0].time,original);assert.equal(f.st.unread.length,1);assert.match(await f.h.buildWakePromptV2(f.key,'question'),/可见的测试画面事实/);assert.equal(f.h.calls.prompts.length,1);assert.equal(f.st.proactiveGreetingEnabled,false);assert.equal(fs.readFileSync(f.h.temp+'/state/social-v2.json','utf8').includes('可见的测试画面事实'),false);}finally{await f.close();}
});
test('同一管理员处理请求去重，不重复分析、不重复唤醒、不重复扣群额度',async()=>{
 const f=await fixture();try{await f.post({key:f.key,messageId:'77'});await f.post({key:f.key,messageId:'77'});assert.equal(f.analyses(),1);assert.equal(f.h.calls.prompts.length,1);assert.equal(JSON.parse(fs.readFileSync(f.h.temp+'/state/bilibili/reply-quota.json','utf8')).rows.length,1);}finally{await f.close();}
});
test('会话agent不能调用管理员视频入口，撤权目标/未知原消息在读取前拒绝',async()=>{
 const f=await fixture();try{assert.equal((await f.post({key:f.key,messageId:'77'},true)).status,403);assert.equal((await f.post({key:f.key,messageId:'77'},'marker')).status,403);assert.equal((await f.post({key:'group:789',messageId:'77'})).status,403);assert.equal((await f.post({key:f.key,messageId:'999'})).status,404);assert.equal(f.analyses(),0);}finally{await f.close();}
});
