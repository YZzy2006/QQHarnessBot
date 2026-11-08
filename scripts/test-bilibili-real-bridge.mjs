import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';
import{bridgeHarness}from'./audit-bridge-harness.mjs';import{createBilibiliBridge}from'../src/bilibili-bridge.js';
const root=new URL('..',import.meta.url);
let proactiveTargets;
test('真实QQ入口私聊改额度、指定群分享、无B站写动作且不存长记忆',async()=>{
 const h=await bridgeHarness({config:{allow:{private:['123','234'],groups:['456']},sendDelayMinMs:0,sendDelayMaxMs:0,sendLimits:{private:{perMinute:100,perHour:300,perDay:500},group:{perMinute:100,perHour:300,perDay:500}}},
 files:{
 'state/current-role.json':{role:'fixture-card',mode:'normal'},
 'roles/fixture-card.md':'这是当前完整人物卡 PRIMARY_TEST_PERSONA_ONLY，不使用其他人格。',
 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml':fs.readFileSync(new URL('dsh/agent-presets/qq-chat-v2/agent.cordis.yml',root),'utf8'),
 'state/bilibili/credentials.json':{sessdata:'a'.repeat(30),bili_jct:'b'.repeat(32),buvid3:''}
 },globals:{createBilibiliBridge:d=>{proactiveTargets=d.getProactiveTargets;return createBilibiliBridge({...d,transport:{fetch:async(url)=>{
  const u=new URL(url);if(u.pathname==='/x/frontend/finger/spi')return Response.json({code:0,data:{b_3:'fixture-initialized-device'}});if(u.pathname==='/x/web-interface/nav')return Response.json({code:0,data:{isLogin:true,wbi_img:{img_url:'https://i/a/'+'a'.repeat(32)+'.png',sub_url:'https://i/a/'+'b'.repeat(32)+'.png'}}});assert.equal(u.pathname,'/x/web-interface/wbi/view');assert.match(u.searchParams.get('w_rid')||'',/^[0-9a-f]{32}$/);return Response.json({code:0,data:{bvid:'BV1100100004',title:'真实元数据标题',pic:'https://i0.hdslb.com/bfs/archive/fixture.jpg',cid:1,duration:10,pages:[{page:1,cid:1}]}});
 }}});}}});
 h.setMode('reserved2');let seq=85000;
 async function command(text,user=123){
  await h.handleIncoming('private',user,{user_id:user,self_id:h.calls.selfUin,sender:{user_id:user,nickname:String(user)},message_id:seq++,message:[{type:'text',data:{text}}]},h.cfg);
 }
 try{
  await command('[B站限额][群聊主动][5]');
  const file=path.join(h.temp,'state/bilibili/control.json');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).limits.groupDaily,5);
  await command('[B站限额][群聊主动][99]',234);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).limits.groupDaily,5);
  await command('[分享B站][BV1100100004][group:456]');
  assert.ok(h.calls.sent.some(v=>v.kind==='group'&&v.id===456&&v.segments?.some(s=>s.type==='image')),JSON.stringify(h.calls.sent));
  assert.ok(h.calls.sent.some(v=>v.kind==='private'&&v.text.includes('已按要求分享')));
  assert.equal(JSON.stringify(h.socialV2).includes('真实元数据标题'),false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).shares[0].automatic,false);
  h.appendSocialV2Message('group:456','member','这个视频是什么','这个视频是什么',false,false,86000,[],'234');
  const sharedPrompt=await h.buildWakePromptV2('group:456','question');
  assert.match(sharedPrompt,/真实元数据标题/);
  assert.match(sharedPrompt,/未读取画面/);
  assert.doesNotMatch(await h.buildWakePromptV2('private:234','private'),/真实元数据标题/);
  h.appendSocialV2Message('private:234','fixture','fixture','fixture',false,false,86001,[],'234');
  assert.deepEqual(Array.from(proactiveTargets()).sort(),['group:456','private:123','private:234'].sort(),'真实桥接传入活动目标选择器');
  await command('[B站状态]');assert.ok(h.calls.sent.some(v=>v.text.includes('B站评论/回复/私信')));
 }finally{await h.close();}
});
