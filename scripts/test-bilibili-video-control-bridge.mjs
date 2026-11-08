import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{bridgeHarness}from'./audit-bridge-harness.mjs';import{createBilibiliBridge}from'../src/bilibili-bridge.js';
const isCard=s=>s.type==='image';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=','base64');
test('QQ管理员私聊视频帮助、单括号分享、定向观看及缓存、权限与记忆隔离',async()=>{
 let analyses=0,downloads=0,reads=0;
 const h=await bridgeHarness({config:{vision:{fallbackEnabled:true},allow:{private:['123','234'],groups:['456']},sendDelayMinMs:0,sendDelayMaxMs:0,sendLimits:{private:{perMinute:100,perHour:300,perDay:500},group:{perMinute:100,perHour:300,perDay:500}}},files:{
 'state/current-role.json':{role:'fixture-card',mode:'normal'},'roles/fixture-card.md':'唯一当前测试人物卡',
 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml':fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml',import.meta.url),'utf8'),
 'state/bilibili/credentials.json':{sessdata:'a'.repeat(30),bili_jct:'b'.repeat(32),buvid3:'fixture-device-identifier'}},globals:{
 isPublicBilibiliVideo:async()=>true, // This fixture is an anonymously verified public video.
 safeFetchMedia:async()=>{downloads++;return{buffer:Buffer.from('fixture-video')};},
 withVideoEvidence:async(b,o,fn)=>fn({duration:20,frames:[{at:0,buffer:png}],coverage:'受限采样'}),
 analyzeVideoEvidence:async()=>{analyses++;return'隔离的测试画面事实';},
 createBilibiliBridge:d=>createBilibiliBridge({...d,requestRole:async q=>{assert.equal(q.kind,'share');assert.match(q.system,/唯一当前测试人物卡/);assert.match(q.facts.evidence,/隔离的测试画面事实/);return'看到了测试画面，分享一下';},transport:{fetch:async url=>{
  reads++;const u=new URL(url);assert.equal(u.hostname,'api.bilibili.com');
  const data=u.pathname==='/x/web-interface/nav'?{isLogin:true,wbi_img:{img_url:'https://i/a/'+'a'.repeat(32)+'.png',sub_url:'https://i/a/'+'b'.repeat(32)+'.png'}}:
   u.pathname==='/x/web-interface/wbi/view'?{bvid:'BV1100100004',title:'视频控制测试标题',pic:'http://i0.hdslb.com/bfs/archive/fixture.jpg',cid:1,duration:20,pages:[{page:1,cid:1}]}:
   u.pathname==='/x/player/wbi/v2'?{subtitle:{subtitles:[]}}:
   u.pathname==='/x/player/wbi/playurl'?{durl:[{url:'https://cdn.bilivideo.com/fixture.mp4',size:100}]}:null;
  assert.ok(data,u.pathname);return Response.json({code:0,data});
 }}})}});
 h.setMode('reserved2');h.calls.nativeCardFailure=true;let seq=91000;
 const command=async(text,user=123,kind='private')=>h.handleIncoming(kind,kind==='private'?user:456,{user_id:user,self_id:h.calls.selfUin,sender:{user_id:user,nickname:String(user)},message_id:seq++,message:[{type:'text',data:{text}}]},h.cfg);
 try{
  await command('[视频帮助]');assert.ok(h.calls.sent.some(v=>v.text.includes('[观看视频')));
  await command('[分享视频 【电脑标题】 https://www.bilibili.com/video/BV1100100004/?share_source=copy_web group:456]');assert.equal(downloads,0);assert.ok(h.calls.sent.some(v=>v.kind==='group'&&v.id===456&&v.text.includes('视频控制测试标题')));
  const first=h.calls.sent.find(v=>v.kind==='group'&&v.id===456&&v.segments?.some(isCard));assert.ok(first,'必须发送标题封面链接图文');assert.equal(first.segments.length,3);assert.equal(first.segments[0].data.text,'【视频控制测试标题】\n');assert.equal(first.segments[1].data.file,'https://i0.hdslb.com/bfs/archive/fixture.jpg');assert.equal(first.segments[2].data.text,'\nhttps://www.bilibili.com/video/BV1100100004');
  h.calls.getMessageData['88']={message_id:88,sender:{user_id:123},message:[{type:'json',data:{data:JSON.stringify({meta:{detail_1:{qqdocurl:'https://www.bilibili.com/video/BV1100100004'}}})}}]};
  const reply=async(text,quotedId='88')=>h.handleIncoming('private',123,{user_id:123,self_id:h.calls.selfUin,sender:{user_id:123,nickname:'管理员'},message_id:seq++,message:[{type:'reply',data:{id:quotedId}},{type:'text',data:{text}}]},h.cfg);
  await reply('分享到 group:456');assert.ok(h.calls.sent.at(-2).segments.some(isCard));
  const beforeWrong=h.calls.sent.filter(v=>v.segments?.some(isCard)).length;h.calls.getMessageData['88'].sender.user_id=234;await reply('分享到 group:456');assert.equal(h.calls.sent.filter(v=>v.segments?.some(isCard)).length,beforeWrong);h.calls.getMessageData['88'].sender.user_id=123;
  await command('[分享视频 BV1100100004]');const ownCardId=String(990000+h.calls.sent.length);await reply('分享到 group:456',ownCardId);assert.ok(h.calls.sent.at(-2).segments.some(isCard),'引用服务端小程序卡片的opaque URL仍找到原视频');
  await command('[观看视频 BV1100100004 群456]');assert.equal(analyses,1);assert.equal(downloads,1);
  assert.ok(h.calls.sent.some(v=>v.kind==='group'&&v.id===456&&v.text.includes('【视频控制测试标题】')));
  assert.equal(JSON.parse(fs.readFileSync(h.temp+'/state/bilibili/reply-quota.json','utf8')).rows[0].key,'group:456');
  const count=reads;await command('[观看视频][BV1100100004][group:456]');assert.equal(analyses,1);assert.equal(downloads,1);assert.equal(reads,count);
  await command('[分享视频 BV1100100004 private:234]');assert.ok(h.calls.sent.some(v=>v.kind==='private'&&v.id===234&&v.segments?.some(isCard)));
  await command('[观看视频 BV1100100004]');assert.equal(analyses,1);
  const beforeReuse=reads;await command('[分享视频 BV1100100004 private:234]');assert.equal(reads,beforeReuse);assert.equal(analyses,1);
  const sent=h.calls.sent.filter(v=>v.kind==='group'&&v.segments?.some(isCard)).length;
  await command('[分享视频 BV1100100004 group:456]',234);await command('[分享视频 BV1100100004 group:456]',123,'group');await command('[观看视频 BV1100100004 group:789]');
  assert.equal(h.calls.sent.filter(v=>v.kind==='group'&&v.segments?.some(isCard)).length,sent);assert.equal(analyses,1);
  assert.equal(JSON.stringify(h.socialV2).includes('隔离的测试画面事实'),false);
  h.calls.cardReadbackFallback=true;const beforeFallback=h.calls.sent.filter(v=>v.segments?.some(isCard)).length;await command('[分享视频 BV1100100004 group:456]');assert.equal(h.calls.sent.filter(v=>v.segments?.some(isCard)).length,beforeFallback+1);assert.match(h.calls.sent.at(-1).text,/会话历史|确认/);h.calls.cardReadbackFallback=false;
  h.calls.suppressShareHistory=true;const beforeGhost=h.calls.sent.filter(v=>v.segments?.some(isCard)).length;await command('[分享视频 BV1100100004]');assert.equal(h.calls.sent.filter(v=>v.segments?.some(isCard)).length,beforeGhost+1);assert.match(h.calls.sent.at(-1).text,/会话历史|确认/);h.calls.suppressShareHistory=false;
  h.calls.shareSendFailure=true;const beforeFailure=h.calls.sent.length;await command('[分享视频 BV1100100004 group:456]');assert.equal(h.calls.sent.length,beforeFailure+1,'失败仅回管理员，无链接降级或重发');assert.match(h.calls.sent.at(-1).text,/未完成/);h.calls.shareSendFailure=false;
  assert.equal(h.calls.prompts.length,0,'管理控制不伪造用户消息、不额外触发DSH回合');
  h.appendSocialV2Message('group:456','member','聊聊这个视频','聊聊这个视频',false,false,92000,[],'234');
  assert.ok((await h.buildWakePromptV2('group:456','question')).includes('隔离的测试画面事实'),'群内正常聊天复用已分享的短期资料');
 }finally{await h.close();}
});
