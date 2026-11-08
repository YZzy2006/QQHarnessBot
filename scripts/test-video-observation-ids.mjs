import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeVideoEvidence} from '../src/media-models.js';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=','base64');
const frames=[{at:0.125,buffer:image},{at:13.923,buffer:image},{at:27.456,buffer:image}];
function run(observations,{board=false,detail=false}={}){
 let body,calls=0;
 const evidence={duration:30,frames,detail,coverage:'fixture'};
 if(board)evidence.storyboard={buffer:image,cols:3,rows:1,cells:frames.map((f,i)=>({index:i+1,at:f.at}))};
 const promise=analyzeVideoEvidence({evidence,apiKey:'fixture-only',fetchImpl:async(url,opts)=>{
  calls++;body=JSON.parse(opts.body);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'有效结果',observations})}}]});
 }});
 return {promise,body:()=>body,calls:()=>calls};
}
for(const board of [false,true])test('stable frame IDs map to actual fractional sampling times with board='+board,async()=>{
 const f=run([{frame_id:'frame_2',text:'第二幅提供的画面'}],{board,detail:board});
 const output=await f.promise;assert.match(output,/\[00:13\] 第二幅提供的画面/);
 const facts=JSON.parse(f.body().messages[1].content[0].text);
 assert.deepEqual(facts.frames,[{frame_id:'frame_1',at:0.125},{frame_id:'frame_2',at:13.923},{frame_id:'frame_3',at:27.456}]);
 assert.match(f.body().messages[0].content,/frame_id/);assert.equal(f.calls(),1);
});
test('invented frame IDs and contradictory time references are rejected without another model call',async()=>{
 for(const observation of [{frame_id:'frame_99',text:'假帧'},{frame_id:'frame_2',at:27.456,text:'冲突'},{frame_id:'frame_2',at:13.92,text:'擅自改时间'}]){
  const f=run([observation]);await assert.rejects(f.promise,/帧|时间/);assert.equal(f.calls(),1);
 }
});
test('legacy exact timestamps remain valid but rounded or invented times are not guessed',async()=>{
 assert.match(await run([{at:13.923,text:'旧格式合法引用'}]).promise,/00:13/);
 for(const at of [14,13.92,15,'00:13'])await assert.rejects(run([{at,text:'未提供的精确时刻'}]).promise,/时间/);
});
test('overlong observation text reports a text error rather than a false time error',async()=>{
 const f=run([{at:13.923,text:'字'.repeat(301)}]);await assert.rejects(f.promise,/文字|文本/);assert.equal(f.calls(),1);
});
