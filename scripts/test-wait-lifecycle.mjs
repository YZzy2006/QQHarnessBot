import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(t){
 const h=await bridgeHarness({config:{socialV2:{wait:{minMs:100,maxMs:2000,minQuietAfterNewMs:0},wake:{preSleepWaitEnabled:true,preSleepWaitMs:500},proactive:{enabled:false},sticker:{enabled:false}}}});h.setMode('reserved2');const key='group:456',st=h.getSocialV2State(key);st.lastIncomingAt=Date.now();
 const server=h.startConsoleServer();if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await h.close();});
 function open(body){
  let request;const result=new Promise((resolve,reject)=>{request=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/socialV2/wait',method:'POST',headers:{'x-console-token':'fixture-console-token','x-agent-token':st.agentToken,'content-type':'application/json'}},res=>{let value='';res.on('data',chunk=>value+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(value)});}catch(e){reject(e);}});});request.on('error',reject);request.end(JSON.stringify({key,...body}));});
  return {request,result};
 }
 return {h,st,key,open};
}
test('断开的普通长等待不会在后台冒充已完成睡前观察',async t=>{
 const f=await setup(t),waiting=f.open({purpose:'messages',timeoutMs:800,quietMs:0});waiting.result.catch(()=>{});await delay(80);waiting.request.destroy();await delay(1100);
 assert.equal(f.st.preSleepWaitSatisfiedAt||0,0,'已断开响应不得更新睡前观察完成标记');assert.equal(f.st.preSleepWaitObservedAt||0,0);
});
test('断开的reply等待不会把未交付给模型的新消息记为已看过',async t=>{
 const f=await setup(t),waiting=f.open({purpose:'reply',timeoutMs:800,quietMs:700});waiting.result.catch(()=>{});await delay(80);waiting.request.destroy();
 f.h.appendSocialV2Message(f.key,'模拟来信','真实新消息示例','真实新消息示例',false,false,'fixture-new',[],'789');await delay(1000);
 assert.equal(f.st.modelSeenSeqs?.size||0,0,'断开的等待不能给未送达消息生成模型已见回执');assert.equal(f.st.unread.length,1);
});
test('正常POST读完请求体后仍按预算等待，真实并发等待拒绝且完成后可再次等待',async t=>{
 const f=await setup(t);const start=Date.now(),first=f.open({purpose:'messages',timeoutMs:700,quietMs:0});await delay(100);const concurrent=await f.open({purpose:'messages',timeoutMs:100,quietMs:0}).result;
 assert.equal(concurrent.status,429);const done=await first.result;assert.equal(done.status,200);assert.ok(Date.now()-start>=650);assert.ok(done.data.waitedMs>=650);
 const next=await f.open({purpose:'reply',timeoutMs:100,quietMs:0}).result;assert.equal(next.status,200);
});
