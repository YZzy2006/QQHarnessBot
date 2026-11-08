import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMediaExperience} from '../src/media-experience.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=','base64');
const ctx={sourceKey:'group:456',userId:'123',directed:true,quotedId:'77'};
function fixture(extra={}){
  let at=100000;const sent=[],images=[],edits=[],questions=[];
  const d={stateDir:'fixture-only',now:()=>at,isAllowed:()=>true,isEnabled:()=>true,redact:String,
    quote:async()=>({message:[{type:'image',data:{url:'https://example.com/x.png'}}]}),
    readImageMessage:async()=>({buffer:png,mimeType:'image/png'}),
    editImage:async input=>{edits.push(input);return {buffer:Buffer.from(png),provider:'qwen',model:'fixture'};},
    readVideoSegment:async()=>({buffer:Buffer.from('fixture-video')}),
    withVideoEvidence:async(b,opts,fn)=>fn({duration:180,frames:[{at:0,buffer:png}],audio:null,coverage:'仅抽一帧'}),
    analyzeVideo:async(e,input)=>{questions.push(input);return '可见测试画面';},
    sendImage:async(key,buffer,authorize)=>{assert.equal(authorize(),true);images.push({key,buffer});return {messageId:String(100+images.length)};},
    say:async(ctx,text,opts)=>{sent.push({ctx,text,opts});},...extra};
  return {d,m:createMediaExperience(d),sent,images,edits,questions,advance:n=>at+=n};
}
test('同一图连续修改携带原图和所选版本，上一版/原图/当前图不调用生成',async()=>{
  const f=fixture();await f.m.handle(ctx,{command:'改图',args:['换背景']});f.advance(16000);
  const next={...ctx,quotedId:undefined,message:[]};await f.m.handle(next,{command:'改图',args:['再调亮']});
  assert.equal(f.edits[0].references.length,1);assert.equal(f.edits[1].references.length,2);assert.equal(f.edits[1].references[0].buffer,png);
  await f.m.handle(next,{command:'上一版',args:[]});await f.m.handle(next,{command:'回到原图',args:[]});await f.m.handle(next,{command:'当前图片',args:[]});assert.equal(f.edits.length,2);
  assert.equal(f.m.stats().entries,1);
});
test('媒体上下文隔离本人和会话，过期/清除后不隐式复活',async()=>{
  const f=fixture();await f.m.handle(ctx,{command:'改图',args:['换背景']});
  for(const other of [{...ctx,userId:'234'},{...ctx,sourceKey:'group:789'}])await assert.rejects(f.m.handle(other,{command:'上一版',args:[]}),/没有.*版本/);
  f.advance(900001);await assert.rejects(f.m.handle(ctx,{command:'上一版',args:[]}),/没有.*版本/);
  assert.equal(f.m.stats().entries,0);
});
test('新发的图片替换旧图片上下文，避免编辑错图',async()=>{
  let second=false;const newer=Buffer.concat([png,Buffer.from('second')]);
  const f=fixture({readImageMessage:async()=>({buffer:second?newer:png})});await f.m.handle(ctx,{command:'改图',args:['第一次']});f.advance(16000);second=true;
  await f.m.handle({...ctx,quotedId:undefined,message:[{type:'image',data:{file:'second.png'}}]},{command:'改图',args:['第二张']});assert.equal(f.edits[1].references[0].buffer,newer);
});
test('视频问答按当前人缓存，追问保留问题与覆盖范围；换了引用不借用旧视频',async()=>{
  const f=fixture({quote:async()=>({message:[{type:'video',data:{url:'https://example.com/v.mp4'}}]})});
  await f.m.handle(ctx,{command:'看视频',args:['讲什么']});assert.match(f.sent.at(-1).text,/覆盖范围：仅抽一帧/);f.advance(16000);
  await f.m.handle({...ctx,quotedId:undefined,message:[]},{command:'视频追问',args:['第二分钟呢']});assert.equal(f.questions[1].question,'第二分钟呢');
  f.d.quote=async()=>({message:[{type:'text',data:{text:'无关原文'}}]});f.advance(16000);
  await assert.rejects(f.m.handle({...ctx,quotedId:'88'},{command:'看视频',args:['讲什么']}),/没有读取到视频/);
  await assert.rejects(f.m.handle({...ctx,userId:'234'},{command:'视频追问',args:['第二分钟']}),/没有.*上下文/);
});
test('取消或撤销权限阻止在途模型结果投递，未知发送回执不重做生成',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const f=fixture({editImage:async()=>{entered();await gate;return {buffer:png};}});
  const work=f.m.handle(ctx,{command:'改图',args:['改背景']});await started;assert.equal(f.m.cancel(ctx),true);release();await assert.rejects(work,/取消|权限/);assert.equal(f.images.length,0);
  let calls=0;const g=fixture({editImage:async()=>{calls++;return {buffer:png};},sendImage:async()=>false});
  await assert.rejects(g.m.handle(ctx,{command:'改图',args:['改背景']}),/回执不明/);assert.equal(calls,1);
});
test('视频处理失败不保留伪视频上下文，暂停时不提交模型',async()=>{
  const f=fixture({quote:async()=>({message:[{type:'video',data:{url:'https://example.com/v.mp4'}}]}),withVideoEvidence:async()=>{throw Error('invalid video');}});
  await assert.rejects(f.m.handle(ctx,{command:'看视频',args:[]}),/invalid video/);assert.equal(f.m.context(ctx).hasVideo,false);
  const g=fixture({isMediaAllowed:()=>false});await assert.rejects(g.m.handle(ctx,{command:'看视频',args:[]}),/权限/);assert.equal(g.questions.length,0);
});
test('空转写不等于ASR服务不可用，视频仍分析画面并如实显示未识别出文字',async()=>{
  const f=fixture({quote:async()=>({message:[{type:'video',data:{url:'https://example.com/v.mp4'}}]}),
    withVideoEvidence:async(b,o,fn)=>fn({duration:6,frames:[{at:0,buffer:png}],audio:{buffer:Buffer.from('wav'),start:0,end:6},coverage:'仅采样画面'}),
    transcribeVideo:async()=>{throw Object.assign(Error('ASR 返回空文本'),{code:'ASR_EMPTY_TRANSCRIPT'});}});
  await f.m.handle(ctx,{command:'看视频',args:[]});
  assert.match(f.sent.at(-1).text,/未识别出可用文字/);assert.doesNotMatch(f.sent.at(-1).text,/转写不可用/);
  assert.equal(f.questions[0].transcript,'');
});
test('全局媒体并发受限；内存不足在下载、配额和模型请求之前拒绝',async()=>{
  let release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const f=fixture({editImage:async()=>{entered();await gate;return {buffer:png};}});
  const work=f.m.handle(ctx,{command:'改图',args:['改背景']});await started;
  await assert.rejects(f.m.handle({...ctx,userId:'234'},{command:'改图',args:['改背景']}),/正在处理/);
  release();await work;assert.equal(f.m.stats().active,0);
  let read=0,reserved=0;
  const g=fixture({checkMediaResources:()=>{throw Error('服务器可用内存不足');},quote:async()=>{read++;},reserveVideo:async()=>{reserved++;}});
  await assert.rejects(g.m.handle(ctx,{command:'看视频',args:[]}),/内存不足/);
  assert.equal(read,0);assert.equal(reserved,0);assert.equal(g.questions.length,0);assert.equal(g.m.stats().active,0);
});
test('分享地址的签名和访问参数不额外进入模型问题',async()=>{
  const f=fixture({downloadVideo:async()=>({buffer:Buffer.from('fixture-video')})});
  await f.m.handle(ctx,{command:'看视频',args:['https://example.com/a.mp4?xsec_token=fixture-private-value','看看 https://example.com/a.mp4?xsec_token=fixture-private-value 的内容']});
  assert.equal(f.questions[0].question.includes('fixture-private-value'),false);
  assert.equal(f.sent.at(-1).text.includes('fixture-private-value'),false);
});


test('没有原视频的无效请求不扣视频额度、不占下一条真正请求的15秒冷却',async()=>{
 let quota=0;const f=fixture({quote:async()=>({message:[{type:'text',data:{text:'普通聊天'}}]}),reserveVideo:()=>{quota++;},downloadVideo:async()=>({buffer:Buffer.from('fixture')})});
 await assert.rejects(f.m.handle(ctx,{command:'看视频',args:['总结视频']}),/没有读取到视频/);assert.equal(quota,0);
 await f.m.handle({...ctx,quotedId:undefined},{command:'看视频',args:['https://example.com/a.mp4']});assert.equal(quota,1);assert.equal(f.questions.length,1);
});


test('总结时明确引用另一条视频，必须以新引用为准，不借用旧缓存',async()=>{
 const files=[];let name='first.mp4';const f=fixture({quote:async()=>({message:[{type:'video',data:{file:name}}]}),readVideoSegment:async d=>{files.push(d.file);return{buffer:Buffer.from('fixture')};}});
 await f.m.handle(ctx,{command:'看视频',args:[]});f.advance(16000);name='second.mp4';
 await f.m.handle({...ctx,quotedId:'88'},{command:'视频追问',args:['总结这个视频'],reuseOnly:true});
 assert.deepEqual(files,['first.mp4','second.mp4']);assert.equal(f.questions.length,2);
});
