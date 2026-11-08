import {test} from 'node:test';import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const card={title:'回坊烤肉',url:'https://www.bilibili.com/video/BV1100100004',image:'https://i0.hdslb.com/bfs/fixture.jpg'};
const comment='一块二一串，听着就想多拿几串。排队太久的话，我得先找点东西垫垫。';
async function fixture(t,onDelay=()=>{},config={}){
 let clock=0;const delays=[];
 const h=await bridgeHarness({config:{sendDelayMinMs:0,sendDelayMaxMs:0,allow:{private:['123'],groups:['456']},...config},globals:{performance:{now:()=>clock+=5000},setTimeout:(fn,ms)=>{if(ms>=2000&&ms<=3000){delays.push(ms);onDelay(h);return setTimeout(fn,0);}return setTimeout(fn,ms);}}});
 h.setMode('reserved2');t.after(()=>h.close());return{h,delays};
}
test('先发完整图文，同一目标等2–3秒补一条感想，按两条限流且不调用模型',async t=>{
 const {h,delays}=await fixture(t);const r=await h.sendBilibiliShare('private:123','',{card,comment,manual:true,authorize:()=>true});
 assert.equal(h.calls.sent.length,2);assert.equal(h.calls.sent[0].segments.some(s=>s.type==='image'),true);
 assert.equal(h.calls.sent[1].text,comment);assert.equal(h.calls.sent[1].id,123);assert.equal(delays.length,1);assert.ok(delays[0]>=2000&&delays[0]<=3000);
 assert.equal(r.commentSent,true);assert.equal(h.getSocialV2State('private:123').sendTimes.length,2);assert.equal(h.calls.prompts.length,0);
});
test('图文未确认不发送感想，也不重发图文',async t=>{
 const {h,delays}=await fixture(t);h.calls.suppressShareHistory=true;
 await assert.rejects(h.sendBilibiliShare('group:456','',{card,comment,manual:true,authorize:()=>true}),/会话历史|确认/);
 assert.equal(h.calls.sent.length,1);assert.equal(delays.length,0);
});
test('延迟期间取消权限时保留图文成功结果，不再补发或重发',async t=>{
 let allowed=true;const {h}=await fixture(t,()=>allowed=false);
 const r=await h.sendBilibiliShare('group:456','',{card,comment,manual:true,authorize:()=>allowed});
 assert.equal(r.sent,true);assert.equal(r.commentSent,false);assert.equal(h.calls.sent.length,1);
});
test('补充消息失败不能把已送达图文报成失败，不自动重试',async t=>{
 const {h}=await fixture(t,h=>h.calls.biliFollowupFailure=true);
 const r=await h.sendBilibiliShare('private:123','',{card,comment,manual:true,authorize:()=>true});
 assert.equal(r.sent,true);assert.equal(r.commentSent,false);assert.equal(h.calls.sent.length,1);
});
test('两条额度不足时整组不开始；仅分享链接没有已读感想时仍只发一条',async t=>{
 const {h}=await fixture(t,()=>{},{sendLimits:{private:{perMinute:1,perHour:10,perDay:10}}});
 assert.equal(await h.sendBilibiliShare('private:123','',{card,comment,manual:true,authorize:()=>true}),false);assert.equal(h.calls.sent.length,0);
 const next=await fixture(t);await next.h.sendBilibiliShare('private:123','',{card,manual:true,authorize:()=>true});assert.equal(next.h.calls.sent.length,1);assert.equal(next.delays.length,0);
});
