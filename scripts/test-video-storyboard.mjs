import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {withVideoEvidence} from '../src/video-reader.js';
import {analyzeVideoEvidence} from '../src/media-models.js';
import {createExperienceDialogue} from '../src/experience-dialogue.js';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=','base64');
test('真实场景扫描生成编号宫格和时间表，时间点追问保留精确锚点，临时文件全部清理',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-storyboard-test-'));
  try{
    const source=path.join(root,'scene.mp4');
    execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:size=320x180:rate=12:duration=2','-f','lavfi','-i','color=c=blue:size=320x180:rate=12:duration=2','-filter_complex_threads','1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','mpeg4','-threads','1',source],{timeout:20000,windowsHide:true});
    const buffer=fs.readFileSync(source);
    await withVideoEvidence(buffer,{tempRoot:path.join(root,'work')},async e=>{
      assert.equal(e.sampling.method,'scene-aware');assert.ok(e.sampling.cuts>=1);
      assert.ok(e.storyboard.buffer.length>100);assert.ok(e.storyboard.width*e.storyboard.height<=640000);
      assert.equal(e.storyboard.cells.length,e.frames.length);assert.ok(e.frames.some(f=>f.at<2)&&e.frames.some(f=>f.at>2));
      assert.deepEqual(e.storyboard.cells.map(c=>c.at),e.frames.map(f=>f.at));assert.equal(e.detail,false);
    });
    await withVideoEvidence(buffer,{tempRoot:path.join(root,'work'),question:'第2秒的画面放大看清楚'},async e=>{
      assert.equal(e.detail,true);assert.ok(e.frames.some(f=>Math.abs(f.at-2)<0.001));assert.ok(e.storyboard);
    });
    assert.deepEqual(fs.readdirSync(path.join(root,'work')),[]);
  }finally{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}
});
test('概览只提交一张内部宫格；细节模式追加有限独立大图，观察时间仍须对应真实采样',async()=>{
  const evidence={duration:20,frames:[{at:0,buffer:image},{at:10,buffer:image}],coverage:'有限采样',storyboard:{buffer:image,cols:2,rows:1,cells:[{index:1,at:0},{index:2,at:10}]}};
  const bodies=[];const fetchImpl=async(url,opts)=>{bodies.push(JSON.parse(opts.body));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'可见两个场景',observations:[{at:10,text:'第二格'}]})}}]});};
  await analyzeVideoEvidence({evidence,apiKey:'fixture',fetchImpl});
  await analyzeVideoEvidence({evidence:{...evidence,detail:true},apiKey:'fixture',fetchImpl});
  assert.equal(bodies[0].messages[1].content.filter(v=>v.type==='image_url').length,1);
  assert.equal(bodies[1].messages[1].content.filter(v=>v.type==='image_url').length,3);
  assert.ok(bodies[0].messages[1].content[0].text.includes('cells'));assert.equal(bodies[0].tools,undefined);
});
test('扫描超时降级为受限时间采样，不重试模型，且清理精确属于本次的文件',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-storyboard-budget-'));
  try{
    const source=path.join(root,'tiny.mp4');
    execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:size=320x180:rate=12','-t','2','-c:v','mpeg4','-threads','1',source],{timeout:20000,windowsHide:true});
    await withVideoEvidence(fs.readFileSync(source),{tempRoot:path.join(root,'work'),scanTimeoutMs:1},async e=>{
      assert.equal(e.sampling.method,'uniform-fallback');assert.match(e.coverage,/预算|降级/);assert.ok(e.storyboard);
    });
    assert.deepEqual(fs.readdirSync(path.join(root,'work')),[]);
  }finally{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}
});
test('自然细节追问只使用本人视频上下文，宫格伪造时间表在请求模型前拒绝',async()=>{
  const d=createExperienceDialogue(),ctx={sourceKey:'private:123',userId:'123',directed:true};
  assert.equal(d.resolve(ctx,'小屏幕上那个蓝头发的是谁',{hasVideo:true})?.command,'视频追问');
  assert.equal(d.resolve(ctx,'把刚才的画面放大看看',{hasVideo:true})?.command,'视频追问');
  assert.equal(d.resolve(ctx,'小屏幕上那个蓝头发的是谁',{}),null);
  let calls=0;
  await assert.rejects(analyzeVideoEvidence({evidence:{duration:20,frames:[{at:0,buffer:image}],storyboard:{buffer:image,cols:1,rows:1,cells:[{index:1,at:10}]}},apiKey:'fixture',fetchImpl:async()=>{calls++;}}),/时间清单/);
  assert.equal(calls,0);
});
