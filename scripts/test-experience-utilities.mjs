import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUtilities} from '../src/utilities.js';
import {utilityFixture,ownerCtx} from './utility-test-fixture.mjs';
const ctx={...ownerCtx,sourceKey:'group:456',quotedId:'77',directed:true};
test('自然截图请求与确认导出走原预览/队列，不给模型新增动作权限',async()=>{
  const files=[],f=utilityFixture({extractStructured:async()=>JSON.stringify({columns:['编号'],rows:[['001']]}),sendFile:async(key,value,guard)=>{assert.ok(guard());files.push(value);return true;}});
  try{
    const u=createUtilities(f.d);assert.equal(await u.handle(ctx,'帮我把这张截图整理成Excel'),true);assert.equal(files.length,0);
    assert.equal(await u.handle({...ctx,quotedId:undefined},'确认导出'),true);assert.equal(files.length,1);
    assert.equal(await u.handle({...ctx,userId:'234'},'确认导出'),false);
  }finally{f.close();}
});
test('结果卡片和原文仅在原目标本人可取，字体失败退回文字且不重复提交模型',async()=>{
  const pictures=[],f=utilityFixture({renderCard:()=>[{buffer:Buffer.from('fixture-png')}],sendImage:async(key,buffer,guard)=>{assert.ok(guard());pictures.push(key);return {messageId:'1'};}});
  try{
    const u=createUtilities(f.d);await u.handle(ownerCtx,'[我的订阅]');await u.handle(ownerCtx,'[结果卡片]');assert.deepEqual(pictures,['private:123']);
    await u.handle({...ctx,quotedId:undefined},'[结果卡片]');assert.equal(pictures.length,1);assert.match(f.sent.at(-1).text,/没有.*结果/);
    await u.handle(ownerCtx,'给我原文');assert.match(f.sent.at(-1).text,/我的订阅/);
    f.advance(900001);await u.handle(ownerCtx,'[结果原文]');assert.match(f.sent.at(-1).text,/没有.*有效工具结果/);
    f.d.renderCard=()=>{throw Error('字体不可用');};const other=createUtilities(f.d);await other.handle(ownerCtx,'[我的订阅]');await other.handle(ownerCtx,'[结果卡片]');assert.match(f.sent.at(-1).text,/我的订阅/);
  }finally{f.close();}
});
test('私人周记引用不能进入卡片或视频资料，未识别的普通聊天不调用模型',async()=>{
  let calls=0;const f=utilityFixture({getMessage:async()=>{throw Error('私有周记不能读取');},analyzeVideo:async()=>{calls++;return '不应发生';},renderCard:()=>{calls++;return [];}});
  try{
    const u=createUtilities(f.d);await u.handle(ctx,'[结果卡片]');assert.match(f.sent.at(-1).text,/私有周记/);assert.equal(calls,0);
    assert.equal(await u.handle(ctx,'今天天气真不错'),false);assert.equal(calls,0);
  }finally{f.close();}
});
test('重画引用卡片不建立可执行预览，长引用明确标记保留范围',async()=>{
  const f=utilityFixture({getMessage:async()=>({group_id:456,sender:{user_id:234},message:[{type:'text',data:{text:'【截图表格预览】p_123456abcdef\n'+'x'.repeat(13000)}}]})});
  try{
    const u=createUtilities(f.d);await u.handle(ctx,'[结果原文]');assert.match(f.sent.at(-1).text,/不是完整原文/);
    assert.equal(await u.handle(ctx,'确认导出'),false);
  }finally{f.close();}
});
