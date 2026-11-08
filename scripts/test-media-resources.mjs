import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {availableMemoryBytes,assertMediaResources} from '../src/media-resources.js';

test('Linux按可用内存准入，忽略空闲内存和交换区；不足或读取失败时停止',()=>{
  const info='MemFree: 100 kB\nMemAvailable: 1048576 kB\nSwapFree: 99999999 kB\n';
  assert.equal(availableMemoryBytes(info),1024*1024*1024);
  assert.doesNotThrow(()=>assertMediaResources({platform:'linux',readMeminfo:()=>info,minBytes:768*1024*1024}));
  assert.throws(()=>assertMediaResources({platform:'linux',readMeminfo:()=>info,minBytes:1024*1024*1024+1}),/内存不足/);
  assert.throws(()=>assertMediaResources({platform:'linux',readMeminfo:()=>{throw Error('denied');}}),/无法读取/);
  assert.throws(()=>availableMemoryBytes('SwapFree: 999999999 kB'),/无法读取/);
  assert.doesNotThrow(()=>assertMediaResources({platform:'win32',readMeminfo:()=>{throw Error('not Linux');}}));
});
test('部署预算在独立进程生效，非法预算不静默放宽',()=>{
  const url=new URL('../src/media-resources.js',import.meta.url).href;
  const run=env=>spawnSync(process.execPath,['--input-type=module','-e',`import {MEDIA_LIMITS} from ${JSON.stringify(url)}; console.log(JSON.stringify(MEDIA_LIMITS));`],{env:{...process.env,...env},encoding:'utf8'});
  const result=run({QQ_MEDIA_MAX_ACTIVE:'1',QQ_VIDEO_MAX_MIB:'32',QQ_MEDIA_CACHE_MIB:'64',QQ_MEDIA_MIN_AVAILABLE_MIB:'768',QQ_VIDEO_MAX_PIXELS:'8294400'});
  assert.equal(result.status,0,result.stderr);const limits=JSON.parse(result.stdout);
  assert.equal(limits.active,1);assert.equal(limits.videoBytes,32*1024*1024);assert.equal(limits.cacheBytes,64*1024*1024);assert.equal(limits.minAvailableBytes,768*1024*1024);
  assert.notEqual(run({QQ_MEDIA_MAX_ACTIVE:'0'}).status,0);
  assert.notEqual(run({QQ_VIDEO_MAX_MIB:'64',QQ_MEDIA_CACHE_MIB:'24'}).status,0);
});
