import {test} from 'node:test';import assert from 'node:assert/strict';
import {createBilibiliRole} from '../src/bilibili-role.js';
const ctx={sourceKey:'private:123',userId:'123'};
test('完整当前卡与预设进入请求，无默认人格；候选范围校验',async()=>{
 const seen=[];const r=createBilibiliRole({getRole:()=>({name:'当前角色',text:'完整卡片尾部_12345',presetText:'当前QQ规则',version:'v1'}),request:async q=>{seen.push(q);return q.kind==='keywords'?'{"keywords":["猫咪"]}':'{"bvid":"BV1100100004"}';},redact:String});
 assert.deepEqual(await r.keywords(ctx),['猫咪']);
 assert.match(seen[0].system,/完整卡片尾部_12345/);assert.match(seen[0].system,/当前QQ规则/);
 assert.doesNotMatch(seen[0].system,/鲸鱼娘|默认樱良/);
 assert.equal(await r.choose(ctx,[{bvid:'BV1100100004',title:'fixture'}]),'BV1100100004');
 await assert.rejects(r.choose(ctx,[{bvid:'BVaaaaaaaaaa'}]),/候选/);
});
test('没有卡、模型返回工具请求或选片期间切卡都拒绝',async()=>{
 await assert.rejects(createBilibiliRole({getRole:()=>null,request:()=>{throw Error('should not call');}}).keywords(ctx),/人物卡/);
 let version='one';const r=createBilibiliRole({getRole:()=>({name:'卡',text:'完整卡',version}),redact:String,request:async()=>{version='two';return '{"keywords":["音乐"]}';}});
 await assert.rejects(r.keywords(ctx),/人物卡|切换/);
});

test('分享感想复用当前人物卡和真实证据，要求独立短评且不套固定题材或亲历',async()=>{
 let q;const r=createBilibiliRole({getRole:()=>({name:'当前角色',text:'人物口吻',presetText:'QQ规则',version:'v1'}),request:async v=>{q=v;return'这个运镜有点意思，最后那下回头看得我一激灵。';}});
 const text=await r.composeShare(ctx,{title:'短片',evidence:'结尾有回头镜头'});assert.match(text,/运镜/);
 assert.match(q.system,/2至3秒/);assert.match(q.system,/具体细节/);assert.match(q.system,/不编造亲自/);assert.match(q.system,/不要每条套用固定/);assert.equal(q.facts.evidence,'结尾有回头镜头');
});
