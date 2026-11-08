import{test}from'node:test';import assert from'node:assert/strict';
import{createBilibiliClient,normalizeBilibiliInput}from'../src/bilibili-client.js';
import{mapBilibiliText}from'../src/bilibili-controller.js';
const a={read:()=>({sessdata:'a'.repeat(30),bili_jct:'b'.repeat(32),buvid3:'existing-device'}),generation:()=>0};
test('BV、分P链接及自然语言转发不猜目标',()=>{
 assert.equal(normalizeBilibiliInput('BV1100100004').bvid,'BV1100100004');assert.equal(normalizeBilibiliInput('https://www.bilibili.com/video/BV1100100004?p=2').page,2);
 for(const s of ['https://bilibili.com.evil/video/BV1100100004','https://www.bilibili.com/video/BV1100100004?p=-2','http://www.bilibili.com/video/BV1100100004'])assert.equal(normalizeBilibiliInput(s),null);
 assert.deepEqual(mapBilibiliText('把这个视频分享给游戏群'),{command:'分享B站',args:['这个视频','游戏群']});
 assert.equal(mapBilibiliText('假如把这个视频分享给群'),null);
});
test('首页真实来源、候选受限、签名请求与字幕CDN不带Cookie',async()=>{
 const requests=[];const transport={block:()=>{},fetch:async(url,init={})=>{
  requests.push([String(url),init]);const p=new URL(url).pathname;
  if(p==='/x/web-interface/nav')return Response.json({code:0,data:{isLogin:true,wbi_img:{img_url:'https://i/a/'+ 'a'.repeat(32)+'.png',sub_url:'https://i/a/'+'b'.repeat(32)+'.png'}}});
  if(p.endsWith('/rcmd'))return Response.json({code:0,data:{item:Array.from({length:8},(_,i)=>({bvid:'BV123456789'+i,goto:'av',title:'title'}))}});
  if(p.endsWith('/view'))return Response.json({code:0,data:{bvid:'BV1100100004',title:'title',cid:1,duration:100,pages:[{page:1,cid:1},{page:2,cid:2}]}});
  if(p==='/x/player/wbi/v2')return Response.json({code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://aisubtitle.hdslb.com/bfs/subtitle/x.json'}]}}});
  if(p==='/bfs/subtitle/x.json')return Response.json({body:[{from:1,to:2,content:'测试字幕'}]});
  if(p==='/x/player/wbi/playurl')return Response.json({code:0,data:{durl:[{url:'https://cdn.bilivideo.com/a.mp4',size:123}]}});
  throw Error('unexpected');
 }};
 const c=createBilibiliClient({transport,auth:a});const list=await c.recommend();assert.equal(list.length,3);assert.equal(list[0].origin,'home');assert.match(requests[1][0],/w_rid=/);
 const video=await c.read('BV1100100004',{page:2});assert.equal(video.cid,2);assert.equal(video.subtitles[0].text,'测试字幕');assert.equal(video.mediaUrl,'https://cdn.bilivideo.com/a.mp4');
 assert.equal(requests.find(r=>r[0].includes('aisubtitle'))[1].headers,undefined);
});
