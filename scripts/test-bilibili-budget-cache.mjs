import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createBilibiliReplyQuota} from '../src/bilibili-reply-quota.js';
import {createBilibiliResults} from '../src/bilibili-results.js';
const ref={bvid:'BV1100100004',page:1};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('用户B站每私聊6/群9按北京时间每日独立持久计额，群成员共用9条',t=>{
 const stateDir=fixture(t);let at=Date.UTC(2026,10,2,15,59);const q=createBilibiliReplyQuota({stateDir,now:()=>at});
 for(let i=0;i<6;i++)q.take({sourceKey:'private:123',userId:'123'});
 assert.throws(()=>q.take({sourceKey:'private:123',userId:'123'}),/6/);
 q.take({sourceKey:'private:234',userId:'234'});
 for(let i=0;i<9;i++)q.take({sourceKey:'group:456',userId:i%2?'123':'234'});
 assert.throws(()=>createBilibiliReplyQuota({stateDir,now:()=>at}).take({sourceKey:'group:456',userId:'345'}),/9/);
 at+=60001;q.take({sourceKey:'private:123',userId:'123'});assert.equal(q.count('private:123'),1);
 fs.writeFileSync(q.file,'broken');assert.throws(()=>q.take({sourceKey:'private:123',userId:'123'}),/损坏/);
});
test('同视频链接/BV/分P的结果按会话与说话人隔离，重启复用；已发送群分享允许本群复用',t=>{
 const stateDir=fixture(t);let at=Date.now(),role='v1';const opts={stateDir,now:()=>at,getRoleVersion:()=>role};let r=createBilibiliResults(opts);
 const ctx={sourceKey:'group:456',userId:'123'};r.save(ctx,ref,{summary:'已观察事实',title:'视频标题',cover:'https://i0.hdslb.com/bfs/a.jpg',coverage:'采样'});
 r=createBilibiliResults(opts);assert.equal(r.lookup(ctx,ref).title,'视频标题');assert.equal(r.lookup(ctx,ref).cover,'https://i0.hdslb.com/bfs/a.jpg');assert.equal(r.lookup(ctx,ref).summary,'已观察事实');
 assert.equal(r.lookup({...ctx,userId:'234'},ref).summary,null,'本群其他人仅得已读标记，不能借用个人分析内容');assert.equal(r.lookup({...ctx,sourceKey:'group:789'},ref).summary,null,'跨群只得最小已读标记，不得私人资料');
 assert.equal(r.lookup(ctx,{...ref,page:2}),null);
 r.save(ctx,ref,{summary:'本群已分享事实'},true);assert.equal(r.lookup({...ctx,userId:'234'},ref).summary,'本群已分享事实');
 role='v2';assert.equal(r.lookup(ctx,ref).summary,null,'切卡不注入旧卡资料，但禁止隐式重复分析');
});
test('72小时只保留短期摘要，长期已读索引禁止过期后重复分析；损坏拒绝覆盖',t=>{
 const stateDir=fixture(t);let at=Date.now();const r=createBilibiliResults({stateDir,now:()=>at,getRoleVersion:()=> 'v1'}),ctx={sourceKey:'private:123',userId:'123'};
 r.save(ctx,ref,{summary:'短期资料'});at+=3*86400000+1;const x=r.lookup(ctx,ref);assert.equal(x.seen,true);assert.equal(x.summary,null);
 assert.equal(fs.readFileSync(r.file,'utf8').includes('短期资料'),false);
 fs.writeFileSync(r.file,'broken');assert.throws(()=>r.lookup(ctx,ref),/损坏/);assert.equal(fs.readFileSync(r.file,'utf8'),'broken');
});

import {createMediaExperience} from '../src/media-experience.js';
import {normalizeBilibiliInput} from '../src/bilibili-client.js';
test('B站重复链接和追问命中结果：不下载、不分析、不占额，重启仍复用；主动分析不占回复额度',async t=>{
 const stateDir=fixture(t);let at=Date.now(),analyses=0,downloads=0,replies=0,generic=0,low=false;
 const results=createBilibiliResults({stateDir,now:()=>at,getRoleVersion:()=> 'v1'}),ctx={sourceKey:'private:123',userId:'123',messageId:'1',message:[]};
 const d={stateDir,now:()=>at,isAllowed:()=>true,isEnabled:()=>true,redact:String,
 bilibili:{results,roleVersion:()=> 'v1',recentVideoResult:ctx=>results.recent(ctx),reference:async u=>normalizeBilibiliInput(u),reserveReply:()=>{replies++;}},
 reserveVideo:()=>{generic++;},checkMediaResources:()=>{if(low)throw Error('low memory');},
 resolveBilibili:async()=>({bvid:ref.bvid,page:1,platform:'bilibili',title:'fixture',mediaUrl:'https://cdn.bilivideo.com/x',displayUrl:'https://www.bilibili.com/video/'+ref.bvid}),
 downloadVideo:async()=>{downloads++;return{buffer:Buffer.from('fixture')};},
 withVideoEvidence:async(b,o,fn)=>fn({frames:[],coverage:'采样画面'}),analyzeVideo:async()=>{analyses++;return'已观察事实';},say:async()=>true};
 let m=createMediaExperience(d);await m.handle(ctx,{command:'看视频',args:['https://www.bilibili.com/video/'+ref.bvid]});
 low=true;await m.handle({...ctx,messageId:'2'},{command:'看视频',args:[ref.bvid]});
 await m.handle({...ctx,messageId:'3'},{command:'视频追问',args:['刚才画面怎样']});assert.equal(m.chatContext(ctx).question,'刚才画面怎样');
 m=createMediaExperience(d);await m.handle({...ctx,messageId:'4'},{command:'看视频',args:[ref.bvid]});
 at+=900001;await m.handle({...ctx,messageId:'5'},{command:'视频追问',args:['之前的视频讲什么']});
 assert.deepEqual({analyses,downloads,replies,generic},{analyses:1,downloads:1,replies:1,generic:0});
 low=false;at+=16000;await m.observeResolved(ctx,{...ref,bvid:'BVaaaaaaaaaa',mediaUrl:'https://cdn.bilivideo.com/other',platform:'bilibili'},{quotaSource:'browse'});
 assert.equal(replies,1);assert.equal(generic,0);assert.equal(analyses,2);
 await m.handle(ctx,{command:'清除媒体上下文',args:[]});assert.equal(m.context(ctx).hasVideo,false);
});


test('引用本群普通聊天总结已有视频：复用带时间戳缓存，不下载/识别/扣额/冷却',async t=>{
 const stateDir=fixture(t),ctx={sourceKey:'group:456',userId:'123',messageId:'21',quotedId:'77'},ref={bvid:'BV1100100004',page:1};let quotes=0,publishes=[];
 const results=createBilibiliResults({stateDir,getRoleVersion:()=> 'v1'});results.save(ctx,ref,{summary:'【视频理解】烤肉\n画面依据：\n[00:12] 准备食材\n[01:23] 烤制',coverage:'仅采样'},true);
 const d={stateDir,isAllowed:()=>true,isEnabled:()=>true,redact:String,bilibili:{results,roleVersion:()=> 'v1',recentVideoResult:c=>results.recent(c)},
 quote:async()=>{quotes++;return{message:[{type:'text',data:{text:'行，那个泥炉我是真有点馋了'}}]};},
 analyzeVideo:()=>{throw Error('不得重新识别');},downloadVideo:()=>{throw Error('不得下载');},reserveVideo:()=>{throw Error('不得占额');},onVideoResult:(c,v)=>publishes.push(v),checkMediaResources:()=>{throw Error('缓存复用不进入资源检查');}};
 const m=createMediaExperience(d);
 for(const question of ['总结一下那个视频给我','有没有时间戳，各时间点在说啥'])await m.handle(ctx,{command:'视频追问',args:[question],reuseOnly:true});
 assert.equal(quotes,2);assert.equal(publishes.length,2);assert.match(publishes[1].summary,/01:23/);assert.match(publishes[1].question,/时间戳/);assert.equal(publishes[1].reused,true);
 d.quote=async()=>{throw Error('引用不属于当前会话');};await assert.rejects(m.handle(ctx,{command:'视频追问',args:['总结视频'],reuseOnly:true}),/引用/);assert.equal(publishes.length,2);
});


test('引用已登记的小程序短地址看视频优先用原BV，不把封面图片当视频网页',async t=>{
 const stateDir=fixture(t),ctx={sourceKey:'group:456',userId:'123',messageId:'31',quotedId:'900'},results=createBilibiliResults({stateDir,getRoleVersion:()=> 'v1'});results.save(ctx,ref,{summary:'已缓存画面事实'},true);let quoteChecked=false;
 const d={stateDir,isEnabled:()=>true,isAllowed:()=>true,redact:String,checkMediaResources:()=>{},quote:async()=>{quoteChecked=true;return{message:[{type:'json',data:{data:JSON.stringify({app:'com.tencent.miniapp_01',meta:{detail_1:{url:'m.q.qq.com/a/s/'+'a'.repeat(32),preview:'https://i0.hdslb.com/bfs/a.jpg'}}})}}]};},
 bilibili:{results,roleVersion:()=> 'v1',reference:async u=>normalizeBilibiliInput(u),quotedCardReference:c=>{assert.equal(quoteChecked,true);assert.equal(c.quotedId,'900');return{platform:'bilibili',url:'https://www.bilibili.com/video/'+ref.bvid};}},
 analyzeVideo:()=>{throw Error('不得分析');},downloadVideo:()=>{throw Error('不得下载');},fetchPublic:()=>{throw Error('不得把封面当视频读');},say:async(c,text)=>assert.match(text,/已缓存画面事实/)};
 await createMediaExperience(d).handle(ctx,{command:'看视频',args:[]});
});
