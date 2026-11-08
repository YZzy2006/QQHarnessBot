import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractVideoSource,parseVideoPage,resolveVideoSource,displayMediaUrl} from '../src/media-sources.js';

test('识别普通视频和三平台长短分享及QQ JSON卡片，域名不能伪装',()=>{
  const samples=[['https://example.com/a.mp4','direct'],['来看看 https://b23.tv/abc123','bilibili'],['https://www.bilibili.com/video/BV1xx411c7mD','bilibili'],['1.2 分享 https://v.douyin.com/abc123/ 复制打开抖音','douyin'],['https://www.douyin.com/video/1100100004123456789','douyin'],['http://xhslink.com/o/Abc','xiaohongshu'],['https://www.xiaohongshu.com/explore/abcdef110010000412345678?xsec_token=fixture-only','xiaohongshu']];
  for(const [text,platform] of samples)assert.equal(extractVideoSource(text).platform,platform);
  const card=[{type:'json',data:{data:JSON.stringify({meta:{detail_1:{qqdocurl:'https://b23.tv/abc'}}})}}];
  assert.equal(extractVideoSource(card).platform,'bilibili');
  assert.equal(extractVideoSource('https://bilibili.com.evil.example/x'),null);
  assert.throws(()=>extractVideoSource('http://127.0.0.1/a.mp4'),/公开|内网/);
  assert.equal(displayMediaUrl('https://www.xiaohongshu.com/explore/a?xsec_token=fixture-only#x'),'https://www.xiaohongshu.com/explore/a');
});
test('B站嵌入数据只选该视频，元信息不冒充字幕',()=>{
  const html='<script>window.__INITIAL_STATE__={"videoData":{"title":"课程","desc":"简介","cid":12,"bvid":"BV1xx411c7mD"}};</script><script>window.__playinfo__={"data":{"durl":[{"url":"https://cdn.example/a.mp4"}]}};</script>';
  const out=parseVideoPage(html,'bilibili','https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(out.mediaUrl,'https://cdn.example/a.mp4');assert.equal(out.title,'课程');assert.equal(out.transcript,undefined);
});
test('抖音分享解析公开页面数据，字符串里的括号不截断JSON',()=>{
  const state={loaderData:{'video_(id)/page':{videoInfoRes:{item_list:[{aweme_id:'1100100004123456789',desc:'示例 } 视频',video:{play_addr:{url_list:['https://cdn.example/d.mp4']}}}]}}}};
  const out=parseVideoPage('<script>window._ROUTER_DATA = '+JSON.stringify(state)+'</script>','douyin','https://www.iesdouyin.com/share/video/1100100004123456789/');
  assert.equal(out.mediaUrl,'https://cdn.example/d.mp4');assert.equal(out.title,'示例 } 视频');
});
test('抖音RENDER_DATA和B站公开元数据回退可用，不借用推荐视频',async()=>{
  const state={aweme_detail:{aweme_id:'123',desc:'主视频',video:{play_addr:{url_list:['https://cdn.example/a.mp4']}}}};
  const html='<script id="RENDER_DATA" type="application/json">'+encodeURIComponent(JSON.stringify(state))+'</script>';
  assert.equal(parseVideoPage(html,'douyin','https://www.douyin.com/video/123').mediaUrl,'https://cdn.example/a.mp4');
  assert.equal(parseVideoPage(html,'douyin','https://www.douyin.com/video/999').mediaUrl,'');
  const b=extractVideoSource('https://www.bilibili.com/video/BV1xx411c7mD');
  const out=await resolveVideoSource(b,{fetchPage:async url=>url.includes('/x/web-interface/')?{statusCode:200,body:JSON.stringify({code:0,data:{cid:12,title:'公开视频'}})}:url.includes('/x/player/')?{statusCode:200,body:JSON.stringify({code:0,data:{durl:[{url:'https://cdn.example/b.mp4'}]}})}:{url:b.url,statusCode:412,body:''}});
  assert.equal(out.title,'公开视频');assert.equal(out.mediaUrl,'https://cdn.example/b.mp4');
});
test('小红书只解析当前笔记，undefined不改变字符串原文',()=>{
  const state={note:{noteDetailMap:{abc:{note:{noteId:'abc',title:'文字 :undefined',video:{media:{stream:{h264:[{masterUrl:'https://cdn.example/x.mp4'}]}}}}}}}};
  const html='<script>window.__INITIAL_STATE__='+JSON.stringify(state).replace('"noteId":"abc"','"unused":undefined,"noteId":"abc"')+'</script>';
  const out=parseVideoPage(html,'xiaohongshu','https://www.xiaohongshu.com/explore/abc');
  assert.equal(out.mediaUrl,'https://cdn.example/x.mp4');assert.equal(out.title,'文字 :undefined');
});
test('普通网页的JSON-LD和og视频可读取；不执行网页中的JS',()=>{
  const html='<script type="application/ld+json">{"@type":"VideoObject","name":"演示","contentUrl":"https://cdn.example/v.mp4"}</script><script>throw new Error("must not execute")</script>';
  assert.equal(parseVideoPage(html,'page','https://example.com/watch').mediaUrl,'https://cdn.example/v.mp4');
  assert.equal(parseVideoPage('<meta content="https://cdn.example/x.mp4?a=1&amp;b=2" property="og:video">','page','https://example.com/watch').mediaUrl,'https://cdn.example/x.mp4?a=1&b=2');
});
test('短链先安全解析，登录限制、截断和内网媒体都失败关闭',async()=>{
  const source=extractVideoSource('https://v.douyin.com/abc/');
  const state={aweme_detail:{desc:'短片',video:{play_addr:{url_list:['https://cdn.example/d.mp4']}}}};
  const out=await resolveVideoSource(source,{fetchPage:async()=>({url:'https://www.iesdouyin.com/share/video/123/',statusCode:200,body:'window._ROUTER_DATA='+JSON.stringify(state)})});
  assert.equal(out.mediaUrl,'https://cdn.example/d.mp4');
  await assert.rejects(resolveVideoSource(source,{fetchPage:async()=>({url:source.url,statusCode:403,body:'登录'})}),/未取得|限制/);
  await assert.rejects(resolveVideoSource(source,{fetchPage:async()=>({url:source.url,statusCode:200,truncated:true,body:'x'})}),/截断/);
  assert.throws(()=>parseVideoPage('<meta property="og:video" content="http://127.0.0.1/private">','page','https://example.com'),/公开|内网/);
});
test('无扩展名的公开视频依据响应类型识别，不能把错误页当视频',async()=>{
  const source=extractVideoSource('https://example.com/download?id=123',{allowPage:true});
  const out=await resolveVideoSource(source,{fetchPage:async()=>({url:source.url,statusCode:200,contentType:'video/mp4',truncated:true,body:'not used'})});
  assert.equal(out.mediaUrl,source.url);
  await assert.rejects(resolveVideoSource(source,{fetchPage:async()=>({url:source.url,statusCode:403,contentType:'video/mp4',body:''})}),/未取得/);
});
