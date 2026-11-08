import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import{createBilibiliState}from'../src/bilibili-state.js';import{createBilibiliExperience}from'../src/bilibili-experience.js';
test('手动分享只查元数据，深读共用额度；自动不伪造用户视频或额外发布报告',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-exp-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state=createBilibiliState({stateDir:dir}),sent=[],reads=[];let frames=0;
 const item={bvid:'BV1100100004',title:'title',description:'desc',url:'https://www.bilibili.com/video/BV1100100004'};
 const e=createBilibiliExperience({state,isAllowed:()=>true,canNotify:()=>true,client:{
 resolve:async()=>({bvid:item.bvid,page:1}),recommend:async()=>[item],search:async()=>[item],read:async(b,o)=>{reads.push(o);return{bvid:b,candidate:item,subtitles:[],mediaUrl:'https://cdn.bilivideo.com/x',coverage:'metadata',missing:[]};}},
 role:{snapshot:()=>({version:'v1'}),keywords:async()=>['猫咪'],choose:async p=>item.bvid,composeShare:async(c,f)=>{assert.match(f.evidence,/采样画面/);return'角色感想';}},
 media:()=>({observeResolved:async()=>{frames++;return{summary:'采样画面'};}}),send:async(k,m,o)=>{assert.equal(o.authorize(),true);sent.push([k,m,o]);return true;}});
 const ctx={sourceKey:'private:123',userId:'123'},o={authorize:()=>true,automatic:false,targetKey:'group:456',input:item.bvid};
 await e.share(ctx,o);assert.equal(reads[0].details,false);assert.equal(frames,0);assert.equal(state.readCount(),0);
 await e.browse(ctx,{authorize:()=>true,automatic:true});assert.equal(frames,1);assert.equal(state.readCount(),1);assert.equal(sent.length,2);assert.equal(state.shareCount('private:123'),1);
});

test('主动分享满额在选词/候选/下载之前跳过，不消耗深读',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-early-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state=createBilibiliState({stateDir:dir}),ctx={sourceKey:'private:123',userId:'123'};let calls=0;
 state.finishShare(state.reserveShare({sourceKey:ctx.sourceKey,bvid:'BV1100100004',automatic:true}),true);
 const e=createBilibiliExperience({state,isAllowed:()=>true,canNotify:()=>true,client:{},role:{keywords:()=>{calls++;throw Error('should not run');}},media:()=>({}),send:()=>{throw Error('should not send');}});
 assert.equal((await e.browse(ctx,{automatic:true,authorize:()=>true})).reason,'share-quota');assert.equal(calls,0);assert.equal(state.readCount(),0);
});

test('长字幕不会挤掉已读画面事实，分享与缓存均优先保留画面和覆盖范围',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state=createBilibiliState({stateDir:dir}),item={bvid:'BV1100100004',title:'fixture',description:'desc',url:'https://www.bilibili.com/video/BV1100100004'};let saved;
 const e=createBilibiliExperience({state,isAllowed:()=>true,canNotify:()=>true,results:{lookup:()=>null,save:(c,n,v)=>saved=v},
 client:{recommend:async()=>[item],search:async()=>[],read:async()=>({bvid:item.bvid,candidate:item,subtitles:Array.from({length:300},(_,i)=>({from:i,to:i+1,text:'字幕内容'.repeat(50)})),mediaUrl:'https://cdn.bilivideo.com/x',coverage:'原字幕覆盖',missing:[]})},
 role:{snapshot:()=>({version:'v1'}),keywords:async()=>['fixture'],choose:async()=>item.bvid,composeShare:async(c,f)=>{assert.match(f.evidence,/必须保留的画面事实/);assert.ok(f.evidence.length<4000);return'角色感想';}},
 media:()=>({observeResolved:async()=>({summary:'必须保留的画面事实'})}),send:async()=>true});
 const ctx={sourceKey:'private:123',userId:'123'};await e.browse(ctx,{automatic:true,authorize:()=>true});
 assert.match(saved.summary,/必须保留的画面事实/);assert.match(e.chatContext(ctx.sourceKey).summary,/必须保留的画面事实/);
});


function videoFixture(t,{cached=null,blocked=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-watch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state=createBilibiliState({stateDir:dir}),calls={reads:0,frames:0,sends:[],saved:[]},item={bvid:'BV1100100004',title:'title',description:'desc',url:'https://www.bilibili.com/video/BV1100100004?p=2'};
 const e=createBilibiliExperience({state,isAllowed:()=>true,canNotify:()=>true,
 results:{lookup:c=>c.sourceKey==='private:123'?cached:null,save:(...a)=>calls.saved.push(a)},
 client:{resolve:async()=>({bvid:item.bvid,page:2,url:item.url}),read:async()=>{calls.reads++;return{bvid:item.bvid,page:2,candidate:item,mediaUrl:'https://cdn.bilivideo.com/x',coverage:'采样限制',missing:[]};}},
 role:{snapshot:()=>({version:'v1'}),composeShare:async(c,f)=>{assert.match(f.evidence,/画面事实/);return'自然感想';}},
 media:()=>({observeResolved:async(c,info,o)=>{calls.frames++;assert.equal(c.sourceKey,'group:456');assert.equal(o.quotaSource,'reply');assert.equal(info.page,2);assert.equal(o.authorize(),true);if(blocked)throw Error('群视频请求额度已满');return{summary:'已取得画面事实'};}}),
 send:async(k,m,o)=>{calls.sends.push([k,m,o]);return true;}});
 return{e,state,calls,ctx:{sourceKey:'private:123',userId:'123'},o:{authorize:()=>true,targetKey:'group:456',automatic:false,input:item.url}};
}
test('观看视频按指定目标取样并分享一次，用户视频额度通道，不占主动深读',async t=>{
 const f=videoFixture(t);await f.e.watch(f.ctx,f.o);assert.equal(f.calls.frames,1);assert.equal(f.calls.sends.length,1);assert.equal(f.calls.sends[0][0],'group:456');assert.match(f.calls.sends[0][1],/自然感想/);assert.equal(f.calls.sends[0][2].comment,'自然感想');assert.match(f.calls.sends[0][1],/p=2/);assert.equal(f.state.readCount(),0);assert.equal(f.state.shareCount('group:456'),0);assert.equal(f.calls.saved.at(-1)[3],true);
});
test('显式分享/观看可复用管理员本会话资料，不重复读片',async t=>{
 for(const action of ['share','watch']){const f=videoFixture(t,{cached:{summary:'已缓存画面事实',title:'已缓存标题',coverage:'受限采样',publicEvidence:true}});await f.e[action](f.ctx,f.o);assert.equal(f.calls.reads,0);assert.equal(f.calls.frames,0);assert.equal(f.calls.sends.length,1);}
});
test('观看的已读资料过期或媒体额度失败均不假称已观看、不投递',async t=>{
 const expired=videoFixture(t,{cached:{summary:null}});await assert.rejects(expired.e.watch(expired.ctx,expired.o),/已分析|过期|不可用|可复用/);assert.equal(expired.calls.reads,0);assert.equal(expired.calls.sends.length,0);
 const blocked=videoFixture(t,{blocked:true});await assert.rejects(blocked.e.watch(blocked.ctx,blocked.o),/额度/);assert.equal(blocked.calls.sends.length,0);
});

test('已读摘要过期不妨碍纯转发，元数据分享不重看也不恢复旧资料',async t=>{
 const f=videoFixture(t,{cached:{summary:null}});await f.e.share(f.ctx,f.o);assert.equal(f.calls.reads,1);assert.equal(f.calls.frames,0);assert.equal(f.calls.sends.length,1);assert.equal(f.calls.sends[0][2].comment,'');assert.equal(f.calls.saved.length,0);assert.equal(f.state.readCount(),0);
});

test('跨目标分享不自动携带私人问题分析，纯图文仍可转发',async t=>{
 const f=videoFixture(t,{cached:{summary:'私人问题的画面事实',title:'标题',publicEvidence:false}});await f.e.share(f.ctx,f.o);assert.equal(f.calls.frames,0);assert.equal(f.calls.sends[0][2].comment,'');assert.equal(f.calls.sends[0][1].includes('私人问题'),false);
});
