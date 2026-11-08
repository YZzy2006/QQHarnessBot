import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {withVideoEvidence,sampleVideoTimes,requestedVideoTime,looksLikeVideo} from '../src/video-reader.js';
import {safeFetchMedia} from '../src/safe-fetch.js';

test('抽帧覆盖实际范围和指定时间，越界不猜测；拒绝伪装媒体',()=>{
  assert.equal(requestedVideoTime('第二分钟的操作'),60);assert.equal(requestedVideoTime('第2分0秒的操作'),120);assert.equal(requestedVideoTime('1:25那段'),85);
  const t=sampleVideoTimes(120,'第二分钟');assert.ok(t.some(v=>v===90));assert.ok(t.length<=8&&t.every(v=>v>=0&&v<120));
  assert.throws(()=>sampleVideoTimes(10,'第30秒'),/超出/);
  assert.equal(looksLikeVideo(Buffer.from('#EXTM3U\nhttp://127.0.0.1/x')),false);
});
test('媒体下载拒绝内网、任意头和超大预算',async()=>{
  await assert.rejects(safeFetchMedia('http://127.0.0.1/a.mp4'),/内网/);
  await assert.rejects(safeFetchMedia('https://example.com/a',65*1024*1024),/64MiB/);
  await assert.rejects(safeFetchMedia('https://example.com/a',1024,{referer:'http://localhost/'}),/请求头/);
});
test('实际FFmpeg抽帧和音轨可用，成功/失败后均只清理本次临时文件',{skip:spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0?'需要可选ffmpeg/ffprobe可执行文件':false},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-video-test-'));
  try{
    const source=path.join(root,'fixture.mp4'),sentinel=path.join(root,'keep.txt');fs.writeFileSync(sentinel,'untouched');
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=320x180:rate=6','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2','-c:v','mpeg4','-c:a','aac',source],{windowsHide:true,timeout:20000});
    const bytes=fs.readFileSync(source);assert.equal(looksLikeVideo(bytes),true);
    await withVideoEvidence(bytes,{tempRoot:path.join(root,'work')},async evidence=>{
      if(process.platform==='linux')assert.match(fs.readdirSync(path.join(root,'work'))[0],new RegExp('^video-'+process.pid+'-\\d+-[0-9a-f-]{36}-[A-Za-z0-9]{6}$'));
      if(process.platform==='linux'){
        const program="import importlib.util,time,sys; spec=importlib.util.spec_from_file_location('gc',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); import json; print(json.dumps(m.clean(sys.argv[2],now=time.time()+28800,apply=True)))";
        const guarded=JSON.parse(execFileSync('python3',['-c',program,fileURLToPath(new URL('./cleanup-video-temp.py',import.meta.url)),path.join(root,'work')],{encoding:'utf8',timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
        assert.equal(guarded.skippedActive,1);assert.equal(guarded.removedDirs,0);assert.deepEqual(guarded.errors,[]);
      }
      assert.ok(evidence.duration>=1.9&&evidence.duration<=2.1);assert.ok(evidence.frames.length>=2&&evidence.frames.length<=8);
      assert.ok(evidence.frames.every(f=>f.buffer[0]===255&&f.buffer[1]===216));assert.equal(evidence.audio.buffer.toString('ascii',0,4),'RIFF');
    });
    assert.deepEqual(fs.readdirSync(path.join(root,'work')),[]);
    await assert.rejects(withVideoEvidence(bytes,{tempRoot:path.join(root,'work')},async()=>{throw Error('fixture failure');}),/fixture failure/);
    assert.deepEqual(fs.readdirSync(path.join(root,'work')),[]);assert.equal(fs.readFileSync(sentinel,'utf8'),'untouched');
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
test('实际WebM/MKV/AVI/MOV/FLV分别使用可用参数，MOV外部引用控制不误用于其他容器',{skip:spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0?'需要可选ffmpeg/ffprobe可执行文件':false},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-video-formats-'));
  try{
    for(const [ext,codec] of [['webm','libvpx'],['mkv','mpeg4'],['avi','mpeg4'],['mov','mpeg4'],['flv','flv']]){
      const file=path.join(root,'fixture.'+ext);
      execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:size=160x120:rate=5','-t','1','-c:v',codec,file],{timeout:20000,windowsHide:true});
      await withVideoEvidence(fs.readFileSync(file),{tempRoot:path.join(root,'work')},async e=>assert.ok(e.frames.length>0,ext));
      assert.deepEqual(fs.readdirSync(path.join(root,'work')),[]);
    }
  }finally{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}
});
