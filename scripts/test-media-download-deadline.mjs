import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import net from 'node:net';
import {EventEmitter} from 'node:events';import {StringDecoder} from 'node:string_decoder';
function fixture({duration=12000,connectDelay=100,bodyBytes=128,privateDns=false}={}){
 let now=1000000,nextId=1;const timers=new Map(),requests=[];
 const later=(fn,ms)=>{const id=nextId++;timers.set(id,{at:now+ms,fn});return id;};
 const clear=id=>timers.delete(id);
 function request(options,callback){
  const req=new EventEmitter();req.setTimeout=()=>{};let destroyed=false;const ids=[];
  req.destroy=error=>{if(destroyed)return;destroyed=true;ids.forEach(clear);if(error)req.emit('error',error);};
  requests.push(options);
  req.end=()=>{
   if(net.isIP(options.hostname)===6){ids.push(later(()=>req.emit('error',Object.assign(Error('No IPv6 route'),{code:'ENETUNREACH'})),0));return;}
   ids.push(later(()=>{
    if(destroyed)return;
    const response=new EventEmitter();response.statusCode=200;response.complete=false;response.headers={'content-type':'video/mp4'};
    response.destroy=()=>{ids.forEach(clear);};callback(response);
    ids.push(later(()=>{if(!destroyed)response.emit('data',Buffer.alloc(Math.floor(bodyBytes/2)));},Math.min(5000,duration/2)));
    ids.push(later(()=>{if(destroyed)return;response.emit('data',Buffer.alloc(Math.ceil(bodyBytes/2)));response.complete=true;response.emit('end');},duration));
   },connectDelay));
  };
  return req;
 }
 class ClockDate extends Date{static now(){return now;}}
 const context={URL,Buffer,TextDecoder,StringDecoder,console,Date:ClockDate,
  dns:{promises:{lookup:async()=>privateDns?[{address:'127.0.0.1',family:4}]:[{address:'8.8.8.8',family:4},{address:'2001:4860:4860::8888',family:6}]}},
  net,http:{request},https:{request},setTimeout:later,clearTimeout:clear};
 const source=fs.readFileSync(new URL('../src/safe-fetch.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
 vm.runInNewContext(source+'\nglobalThis.media=safeFetchMedia;',context);
 async function run(limit=1024){
  let result;
  context.media('https://cdn.example/video.mp4',limit,{referer:'https://www.bilibili.com/'}).then(value=>{result={ok:true,value};},error=>{result={ok:false,error};});
  for(let steps=0;steps<50&&!result;steps++){
   await new Promise(setImmediate);
   if(result)break;
   const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
   if(!entry)continue;
   timers.delete(entry[0]);now=entry[1].at;entry[1].fn();
  }
  assert.ok(result,'download should settle within its bounded timers');return result;
 }
 return {run,requests,time:()=>now-1000000};
}
test('an IPv4 video body can finish after 8 seconds without falling back to unreachable IPv6',async()=>{
 const f=fixture();const result=await f.run();
 assert.equal(result.ok,true,result.error?.message);assert.equal(result.value.buffer.length,128);
 assert.equal(f.requests.length,1);assert.equal(net.isIP(f.requests[0].hostname),4);
 assert.equal(f.requests[0].servername,'cdn.example');assert.equal(f.requests[0].headers.host,'cdn.example');
 assert.equal(f.requests[0].headers.cookie,undefined);assert.ok(f.time()>8000&&f.time()<60000);
});
test('the entire media body remains bounded by 60 seconds',async()=>{
 const f=fixture({duration:70000});const result=await f.run();
 assert.equal(result.ok,false);assert.match(result.error.message,/超时/);assert.ok(f.time()<=60000);
 assert.equal(f.requests.length,1,'a consumed total budget must not retry another address');
});
test('connection failures still use the short attempt budget',async()=>{
 const f=fixture({connectDelay:10000});const result=await f.run();
 assert.equal(result.ok,false);assert.ok(f.time()<=8000);assert.equal(f.requests.length,2);
});
test('oversized video bodies and private DNS are still rejected',async()=>{
 const f=fixture({duration:100,bodyBytes:2048});const result=await f.run();
 assert.equal(result.ok,false);assert.match(result.error.message,/超过/);assert.equal(f.requests.length,1);
 const blocked=fixture({privateDns:true});const denied=await blocked.run();
 assert.equal(denied.ok,false);assert.match(denied.error.message,/内网/);assert.equal(blocked.requests.length,0);
});
