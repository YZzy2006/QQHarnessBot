import {test} from 'node:test';import assert from 'node:assert/strict';
import {createMediaExperience} from '../src/media-experience.js';
for(const [draw,allowed] of [[0.1,true],[0.15,false],[0.9,false]])test('视频临时应答低概率且每条只抽一次：'+draw,async()=>{
 let start,release,samples=0;const ready=new Promise(r=>start=r),gate=new Promise(r=>release=r);
 const ctx={sourceKey:'group:456',userId:123,messageId:9};
 const m=createMediaExperience({stateDir:'/tmp/unused-fixture',isAllowed:()=>true,isEnabled:()=>true,redact:String,random:()=>{samples++;return draw;},checkMediaResources:()=>{},downloadVideo:async()=>({buffer:Buffer.from('fixture')}),withVideoEvidence:async(b,o,fn)=>fn({frames:[],coverage:'采样'}),analyzeVideo:async()=>{start();await gate;return'已看见画面';}});
 const running=m.observeResolved(ctx,{mediaUrl:'https://example.com/a.mp4',title:'雪球'});await ready;
 try{
  for(let i=0;i<3;i++){const pending=m.chatContext(ctx);assert.equal(pending.status,'processing');assert.equal(pending.interimReplyAllowed,allowed);assert.equal(pending.interimReplyMaxMessages,1);assert.match(pending.summary,/内部状态/);}
  assert.equal(samples,1);assert.equal(m.chatContext({...ctx,userId:234}),null);
 }finally{release();await running;}
});
