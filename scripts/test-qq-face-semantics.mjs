import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import * as faces from '../src/qq-faces.js';
import {QQ_FACE_DATA} from '../src/qq-face-data.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';

test('日常doge/狗头保命发送真正的狗头277，傲娇仍为179',()=>{
 for(const marker of ['[doge]','[Doge]','[/doge]','【doge】','[狗头]','[狗头保命]','[表情:狗头保命]'])
  assert.deepEqual(faces.buildFaceSegments(marker),[{type:'face',data:{id:'277'}}],marker);
 assert.deepEqual(faces.buildFaceSegments('[傲娇]'),[{type:'face',data:{id:'179'}}]);
 assert.deepEqual(faces.buildFaceSegments('[汪汪]'),[{type:'face',data:{id:'277'}}]);
 assert.equal(QQ_FACE_DATA.doge,'179','原始QQ目录内部名保留，常用别名在应用层覆盖');
});
test('收到277优先称狗头，179称傲娇，不混淆两张脸',()=>{
 assert.equal(faces.faceNameOf(277),'狗头');
 assert.equal(faces.faceNameOf(179),'傲娇');
});
test('入站说明保留可发送标记，并明确玩笑含义与QQ内部命名差异',()=>{
 assert.equal(typeof faces.faceTextOf,'function');
 assert.match(faces.faceTextOf(277),/^\[表情:狗头\].*doge.*狗头保命/);
 assert.match(faces.faceTextOf(277),/玩笑|调侃|反讽/);
 assert.match(faces.faceTextOf(277),/不是狗叫/);
 assert.match(faces.faceTextOf(179),/^\[表情:傲娇\].*内部名doge.*不是狗头/);
 assert.equal(faces.faceTextOf(264),'[表情:捂脸]');
 assert.equal(faces.faceTextOf('999999'),'[表情999999]');
});
test('自动表情按doge保命选狗头，明确傲娇仍选傲娇',()=>{
 const options={probability:1,random:()=>0};
 assert.equal(faces.pickAutoFace('doge一下',options),'狗头');
 assert.equal(faces.pickAutoFace('doge狗头保命',options),'狗头');
 assert.equal(faces.pickAutoFace('傲娇一下',options),'傲娇');
 assert.equal(faces.pickAutoFace('去医院，doge',options),'');
 assert.equal(faces.pickAutoFace('开玩笑[狗头保命]',options),'');
});
test('真实桥接入站按ID说明，忽略上游可能错误的summary，不自动回复狗叫',async()=>{
 const h=await bridgeHarness();
 try{
  const text=await h.segmentsToText([{type:'text',data:{text:'别老傲娇了，换狗头保命'}},{type:'face',data:{id:'277',summary:'傲娇'}}]);
  assert.match(text,/\[表情:狗头\].*不是狗叫/);
  assert.doesNotMatch(text,/\[表情:傲娇\]/);
  const other=await h.segmentsToText([{type:'face',data:{id:'179',summary:'狗头保命'}}]);
  assert.match(other,/\[表情:傲娇\].*不是狗头/);
  h.calls.sent.length=0;
  await h.sendToQQ('private:123','开个玩笑[doge]');
  assert.equal(h.calls.sent.length,1);
  assert.ok(h.calls.sent[0].segments.some(s=>s.type==='face'&&s.data.id==='277'));
 }finally{await h.close();}
});
test('系统预设和发送工具同时纠正狗头与QQ内部doge，不保留旧误导',()=>{
 for(const file of ['dsh/agent-presets/qq-chat-v2/agent.cordis.yml','src/mcp-snowluma-safe.js']){
  const text=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  assert.match(text,/狗头\/doge\/狗头保命=277/);
  assert.match(text,/傲娇=179/);
  assert.match(text,/不是狗叫/);
  assert.doesNotMatch(text,/doge=傲娇脸 179/);
 }
});
