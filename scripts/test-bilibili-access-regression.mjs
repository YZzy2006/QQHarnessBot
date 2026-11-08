import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBilibiliClient} from '../src/bilibili-client.js';
import {createBilibiliTransport,checkBilibiliUrl} from '../src/bilibili-transport.js';
import {extractVideoSource} from '../src/media-sources.js';
import {signWbi} from '../src/vendor/dsh-bili-whale/wbi.js';
const images={img_url:'https://i.example/'+ 'a'.repeat(32)+'.png',sub_url:'https://i.example/'+ 'b'.repeat(32)+'.png'};
const auth={read:()=>({sessdata:'a'.repeat(30),bili_jct:'b'.repeat(32)}),generation:()=>0};
const at=1793544000000;
function fixture({deniedStatus=0,imagesMissing=false,invalidDevice=false,authImpl=auth}={}){
 const requests=[];let deviceCount=0;
 const transport=createBilibiliTransport({now:()=>at,minGapMs:0,lookup:async()=>[{address:'8.8.8.8',family:4}],requestImpl:async q=>{
  const url=q.url,endpoint=url.pathname;requests.push(q);
  if(endpoint==='/x/frontend/finger/spi'){assert.equal(q.headers.cookie,undefined);deviceCount++;return Response.json({code:0,data:{b_3:invalidDevice?'invalid;cookie=inject':'fixture-initialized-device-'+deviceCount}});}
  if(endpoint==='/x/web-interface/nav')return Response.json({code:0,data:{isLogin:true,wbi_img:imagesMissing?undefined:images}});
  if(['/x/web-interface/view','/x/player/playurl'].includes(endpoint))return new Response('<html>restricted legacy endpoint</html>',{status:412});
  if(endpoint==='/x/web-interface/wbi/view'&&deniedStatus)return new Response('<html>restricted</html>',{status:deniedStatus});
  if(['/x/web-interface/wbi/view','/x/player/wbi/v2','/x/player/wbi/playurl'].includes(endpoint)){
   const params=Object.fromEntries(url.searchParams);delete params.w_rid;delete params.wts;
   assert.equal(url.search.slice(1),signWbi(params,images,at),'Bilibili requires a valid WBI signature');
   assert.equal(q.headers.cookie,'SESSDATA='+authImpl.read().sessdata+'; bili_jct='+authImpl.read().bili_jct+'; buvid3='+(authImpl.read().buvid3||'fixture-initialized-device-'+deviceCount));
  }
  if(endpoint==='/x/web-interface/wbi/view')return Response.json({code:0,data:{bvid:'BV1100100004',title:'fixture',cid:123,duration:15,pages:[{page:1,cid:123}]}});
  if(endpoint==='/x/player/wbi/v2')return Response.json({code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fixture.json'}]}}});
  if(endpoint==='/bfs/ai_subtitle/prod/fixture.json'){assert.equal(q.headers.cookie,undefined);return Response.json({body:[{from:0,to:1,content:'fixture subtitle'}]});}
  if(endpoint==='/x/player/wbi/playurl')return Response.json({code:0,data:{durl:[{url:'https://cdn.bilivideo.com/fixture.mp4',size:1024}]}});
  throw Error('Unexpected endpoint '+endpoint);
 }});
 const client=createBilibiliClient({transport,auth:authImpl,now:()=>at,resolveShort:async()=> 'https://www.bilibili.com/video/BV1100100004'});
 return {requests,transport,client};
}
test('link, short link, BV and QQ JSON card all reach a signed readable video source',async()=>{
 const f=fixture();
 const inputs=['https://www.bilibili.com/video/BV1100100004','https://b23.tv/fixture','BV1100100004',[{type:'json',data:{data:JSON.stringify({meta:{detail_1:{qqdocurl:'https://b23.tv/fixture'}}})}}]];
 for(const input of inputs){
  const source=extractVideoSource(input);assert.equal(source.platform,'bilibili');
  const resolved=await f.client.getSource(source.url);
  assert.equal(resolved.mediaUrl,'https://cdn.bilivideo.com/fixture.mp4');assert.equal(resolved.subtitles[0].text,'fixture subtitle');
 }
 assert.equal(f.requests.filter(r=>r.url.pathname==='/x/web-interface/nav').length,1,'navigation keys are cached');
 assert.ok(f.requests.every(r=>!['/x/web-interface/view','/x/player/playurl'].includes(r.url.pathname)));
});
for(const status of [412,429])test('HTTP '+status+' still opens the 15 minute circuit without retry or legacy fallback',async()=>{
 const f=fixture({deniedStatus:status});
 await assert.rejects(f.client.getSource('BV1100100004'),/限制访问.*15分钟/);
 assert.equal(f.transport.status().blockedUntil,at+15*60000);
 const count=f.requests.length;
 await assert.rejects(f.client.getSource('BV1100100004'),/暂停/);
 assert.equal(f.requests.length,count,'no network retry during cooldown');
 assert.equal(f.requests.at(-1).url.pathname,'/x/web-interface/wbi/view');
});
test('missing WBI keys fails before requesting video information',async()=>{
 const f=fixture({imagesMissing:true});
 await assert.rejects(f.client.getSource('BV1100100004'),/WBI.*缺失/);
 assert.deepEqual(f.requests.map(q=>q.url.pathname),['/x/frontend/finger/spi','/x/web-interface/nav']);
});
test('transport rejects legacy and write endpoints rather than silently falling back',()=>{
 for(const endpoint of ['/x/web-interface/view','/x/player/playurl','/x/v2/reply/add','/x/relation/modify']){
  assert.throws(()=>checkBilibiliUrl('https://api.bilibili.com'+endpoint),/拒绝/);
 }
});

test('missing device identifier is initialized once without sending login cookies to the initialization endpoint',async()=>{
 const f=fixture();await f.client.getSource('BV1100100004');await f.client.getSource('BV1100100004');
 assert.equal(f.requests.filter(q=>q.url.pathname==='/x/frontend/finger/spi').length,1);
});
test('existing device identifier is preserved and avoids initialization',async()=>{
 const f=fixture({authImpl:{read:()=>({...auth.read(),buvid3:'existing-device'}),generation:()=>0}});
 await f.client.getSource('BV1100100004');
 assert.equal(f.requests.some(q=>q.url.pathname==='/x/frontend/finger/spi'),false);
});
test('invalid device identifiers fail before account or video requests',async()=>{
 const f=fixture({invalidDevice:true});await assert.rejects(f.client.getSource('BV1100100004'),/设备标识/);
 assert.deepEqual(f.requests.map(q=>q.url.pathname),['/x/frontend/finger/spi']);
});
test('changing login generation invalidates the in-memory device and navigation cache',async()=>{
 let generation=0;let credentials=auth.read();
 const f=fixture({authImpl:{read:()=>credentials,generation:()=>generation}});
 await f.client.getSource('BV1100100004');credentials={...credentials,sessdata:'c'.repeat(30)};generation++;
 await f.client.getSource('BV1100100004');
 assert.equal(f.requests.filter(q=>q.url.pathname==='/x/frontend/finger/spi').length,2);
 assert.equal(f.requests.filter(q=>q.url.pathname==='/x/web-interface/nav').length,2);
});

test('concurrent video reads share one device initialization',async()=>{
 const f=fixture();await Promise.all([f.client.getSource('BV1100100004'),f.client.getSource('BV1100100004')]);
 assert.equal(f.requests.filter(q=>q.url.pathname==='/x/frontend/finger/spi').length,1);
});
