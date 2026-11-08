import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createBilibiliResults} from '../src/bilibili-results.js';
const day=86400000,ref={bvid:'BV1100100004',page:1},a={sourceKey:'private:123',userId:'123'},b={sourceKey:'private:234',userId:'234'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-retain-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let at=Date.now();const r=createBilibiliResults({stateDir:dir,now:()=>at,getRoleVersion:()=> 'v1'});return{dir,r,advance:n=>at+=n,at:()=>at};}
test('摘要最长72小时，重分享不刷新实际分析时间；过期删除标题封面覆盖说明',t=>{
 const f=fixture(t);f.r.save(a,ref,{summary:'原画面',title:'原标题',cover:'https://i0.hdslb.com/x.jpg',coverage:'采样',publicEvidence:true});
 f.advance(2*day);const cached=f.r.lookup(a,ref);assert.equal(cached.summary,'原画面');f.r.save(b,ref,cached,true);f.advance(day+1);
 const expired=f.r.lookup(b,ref);assert.equal(expired.summary,null);assert.equal(expired.seen,true);
 const saved=fs.readFileSync(f.r.file,'utf8');for(const text of ['原画面','原标题','https://i0.hdslb.com/x.jpg'])assert.equal(saved.includes(text),false);
});
test('最小已读索引跨会话、长期保留，不带私人摘要或标题；索引损坏失败关闭',t=>{
 const f=fixture(t);f.r.save(a,ref,{summary:'私人问题及画面',title:'私人标题'});assert.equal(f.r.lookup(b,ref).seen,true);assert.equal(f.r.lookup(b,ref).summary,null);
 f.advance(90*day);assert.equal(f.r.lookup(b,ref).seen,true);assert.equal(f.r.lookup(b,ref).summary,null);
 const marker=fs.readFileSync(path.join(f.dir,'bilibili/video-seen.json'),'utf8');assert.equal(marker.includes('私人'),false);
 fs.writeFileSync(path.join(f.dir,'bilibili/video-seen.json'),'broken');assert.throws(()=>f.r.lookup(a,ref),/损坏/);
});
test('只有明确标记的公共中性资料可跨会话复用；BV分P仍独立',t=>{
 const f=fixture(t);f.r.save(a,ref,{summary:'公开画面事实',publicEvidence:true});assert.equal(f.r.lookup(b,ref).summary,'公开画面事实');assert.equal(f.r.lookup(b,{...ref,page:2}),null);
});
test('旧缓存兼容迁移，不给已清空摘要补内容，不改首次分析时刻',t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.r.file),{recursive:true});fs.writeFileSync(f.r.file,JSON.stringify({version:1,rows:[{scope:'private:123|123',ref:'BV1100100004:1',role:'v1',at:f.at()-2*day,summary:'旧资料',title:'标题'},{scope:'private:123|123',ref:'BVaaaaaaaaaa:1',role:'v1',at:f.at()-day,summary:null,title:'已丢摘要'}]}));
 assert.equal(f.r.lookup(a,ref).summary,'旧资料');assert.equal(f.r.lookup(a,{bvid:'BVaaaaaaaaaa',page:1}).summary,null);f.advance(day+1);assert.equal(f.r.lookup(a,ref).summary,null);
});

import {isPublicBilibiliVideo} from '../src/bilibili-bridge.js';
import {createExperienceDialogue} from '../src/experience-dialogue.js';
import {createMediaExperience} from '../src/media-experience.js';
test('公开来源校验匿名固定API、失败保守，不把私人分析默认公开',async()=>{
 const fetchPublic=async(url,max)=>{assert.equal(new URL(url).hostname,'api.bilibili.com');assert.equal(max,100000);return{statusCode:200,body:JSON.stringify({code:0,data:{bvid:ref.bvid,title:'公开标题',pages:[{page:1}]}})};};
 assert.equal(await isPublicBilibiliVideo(ref,{fetchPublic}),true);assert.equal(await isPublicBilibiliVideo(ref,{fetchPublic:async()=>({statusCode:403})}),false);
});
test('15分钟后旧资料仅在明确提视频时检索，不把普通时间和闲聊当作视频追问',()=>{
 const dialogue=createExperienceDialogue(),ctx={sourceKey:'private:123',userId:123,directed:true,message:[]};
 assert.equal(dialogue.resolve(ctx,'明天14:30提醒我吃饭',{hasArchivedVideo:true}),null);
 assert.equal(dialogue.resolve(ctx,'晚饭吃什么',{hasArchivedVideo:true}),null);
 assert.equal(dialogue.resolve(ctx,'昨天那个雪球视频是怎么做的',{hasArchivedVideo:true}).command,'视频追问');assert.equal(dialogue.resolve(ctx,'那个雪球视频怎么做',{hasArchivedVideo:true}).command,'视频追问');
});
test('旧视频按标题与日期选取，遇到歧义不强用最近一条',t=>{
 const f=fixture(t);f.r.save(a,ref,{summary:'雪球步骤',title:'如何做完美雪球'});f.r.save(a,{bvid:'BVaaaaaaaaaa',page:1},{summary:'猫画面',title:'猫的小手不太干净'});
 assert.equal(f.r.find(a,'之前那个雪球视频怎么做').bvid,ref.bvid);assert.throws(()=>f.r.find(a,'之前那个视频'),/多条/);assert.throws(()=>f.r.find(b,'之前那个雪球视频'),/没有找到/);
});
test('过期重复视频不分析不扣额，只有明确重新看才读且更新分析时间',async t=>{
 const f=fixture(t);f.r.save(a,ref,{summary:'旧画面'});f.advance(4*day);let analyses=0,quota=0;
 const d={stateDir:f.dir,now:f.at,isAllowed:()=>true,isEnabled:()=>true,redact:String,checkMediaResources:()=>{},bilibili:{results:f.r,roleVersion:()=> 'v1',reference:async()=>({...ref,url:'https://www.bilibili.com/video/'+ref.bvid}),reserveReply:()=>{quota++;}},resolveBilibili:async()=>({platform:'bilibili',bvid:ref.bvid,page:1,title:'片',mediaUrl:'https://example.com/a.mp4'}),downloadVideo:async()=>({buffer:Buffer.from('fixture')}),withVideoEvidence:async(b,o,fn)=>fn({frames:[],coverage:'受限采样'}),analyzeVideo:async()=>{analyses++;return'重新读到的画面';},say:async()=>true};
 const m=createMediaExperience(d),url='https://www.bilibili.com/video/'+ref.bvid;
 await m.handle(a,{command:'看视频',args:[url]});assert.equal(analyses,0);assert.equal(quota,0);
 await m.handle(a,{command:'重新看视频',args:[url]});assert.equal(analyses,1);assert.equal(quota,1);assert.equal(f.r.lookup(a,ref).analyzedAt,f.at());
});
