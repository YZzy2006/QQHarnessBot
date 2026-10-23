import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLifeServices} from '../src/life-services.js';
import {createNewsSearch} from '../src/utility-news.js';
import {createYuanbaoSearch} from '../src/yuanbao-search.js';
import {wgs84ToGcj02,gcj02ToWgs84} from '../src/geo-coordinates.js';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('Yuanbao uses the official API-key endpoint and safely decodes string Pages',async()=>{
  let body,headers;
  const search=createYuanbaoSearch({env:{YUANBAO_SEARCH_API_KEY:'private-token'},fetchImpl:async(url,o)=>{
    assert.equal(String(url),'https://api.wsa.cloud.tencent.com/SearchPro');assert.equal(o.redirect,'error');body=JSON.parse(o.body);headers=o.headers;
    return Response.json({Response:{Pages:[JSON.stringify({title:'发布',url:'https://example.com/new',passage:'真实摘要',date:'2026-10-22'}),'bad json',JSON.stringify({title:'无效链接',url:'file:///secret'}),JSON.stringify({title:'内网地址',url:'http://172.16.0.1/private'})]}});
  }});
  const r=await search('Java',{freshness:'d7'});
  assert.equal(headers.authorization,'Bearer private-token');assert.equal(body.Query,'Java');assert.equal(body.Freshness,'d7');
  assert.equal(r.source,'yuanbao-search');assert.equal(r.results.length,1);assert.equal(r.results[0].snippet,'真实摘要');assert.equal(r.results[0].date,'2026-10-22');
  assert.doesNotMatch(JSON.stringify(r),/private-token/);
});
test('Yuanbao errors never expose credentials or upstream error bodies',async()=>{
  const search=createYuanbaoSearch({env:{YUANBAO_SEARCH_API_KEY:'private-token'},fetchImpl:async()=>Response.json({Response:{Error:{Code:'UnauthorizedOperation',Message:'private-token https://secret.example'}}})});
  await assert.rejects(search('Java'),e=>!e.message.includes('private-token')&&!e.message.includes('secret.example'));
});
test('briefing uses Yuanbao only after both existing search providers fail or have no usable results',async()=>{
  const calls=[];
  const search=createNewsSearch({env:{BOCHA_API_KEY:'bocha',DEEPSEEK_API_KEY:'deepseek',YUANBAO_SEARCH_API_KEY:'yuanbao'},readKey:()=>'',now:()=>Date.parse('2026-10-23T09:00:00+08:00'),fetchImpl:async(url)=>{
    calls.push(String(url));
    if(String(url).includes('bocha'))return Response.json({code:200,data:{webPages:{value:[]}}});
    if(String(url).includes('deepseek'))return Response.json({results:[]});
    return Response.json({Response:{Pages:[JSON.stringify({title:'版本发布',url:'https://example.com/new',passage:'发布摘要',date:'2026-10-22'})]}});
  }});
  const r=await search('Java');assert.equal(r.source,'yuanbao-search');assert.equal(r.results.length,1);assert.equal(calls.length,3);
  calls.length=0;
  const primary=createNewsSearch({env:{BOCHA_API_KEY:'bocha',YUANBAO_SEARCH_API_KEY:'yuanbao'},readKey:()=>'',fetchImpl:async(url)=>{calls.push(String(url));return Response.json({code:200,data:{webPages:{value:[{name:'资料',url:'https://example.com',snippet:'资料摘要'}]}}});}});
  await primary('Java');assert.equal(calls.length,1);assert.match(calls[0],/bocha/);
});
test('GCJ conversion uses a known control point, round trips and leaves overseas points alone',()=>{
  const p=wgs84ToGcj02({lon:116.397128,lat:39.916527});
  assert.ok(Math.abs(p.lon-116.403372494)<1e-7);assert.ok(Math.abs(p.lat-39.917930749)<1e-7);
  const raw=gcj02ToWgs84(p);assert.ok(Math.abs(raw.lon-116.397128)<1e-7);assert.ok(Math.abs(raw.lat-39.916527)<1e-7);
  assert.deepEqual(wgs84ToGcj02({lon:-74,lat:40}),{lon:-74,lat:40});
});
const keys={GAODE_WEB_API_KEY:'gaode-secret',TENGXUNDITU_API_KEY:'tencent-secret',TIANDITU_API_KEY:'tdt-secret',BAIDUDITU_API_KEY:'baidu-secret'};
test('automatic places fall back to Tencent and explicit providers never silently select Gaode',async()=>{
  const calls=[];
  const s=createLifeServices({env:keys,fetchImpl:async(url)=>{
    calls.push(url);if(url.hostname==='restapi.amap.com')return new Response('',{status:503});
    assert.equal(url.hostname,'apis.map.qq.com');assert.equal(url.searchParams.get('key'),'tencent-secret');
    return Response.json({status:0,data:[{id:'tx-id',title:'广州塔',address:'广州市海珠区',location:{lat:23.1,lng:113.3}}]});
  }});
  const r=await s.searchPlaces({query:'广州塔',city:'广州'});assert.equal(r.provider,'tencent');assert.match(r.source,/腾讯/);assert.equal(r.places[0].provider,'tencent');assert.equal(r.places[0].coordinateSystem,'gcj02');assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(r),/secret/);
  calls.length=0;await s.searchPlaces({query:'广州塔',city:'广州',provider:'tencent'});assert.equal(calls.length,1);assert.equal(calls[0].hostname,'apis.map.qq.com');
});
test('Tianditu fallback normalizes coordinates for QQ and translates nearby query centers back',async()=>{
  const calls=[];
  const s=createLifeServices({env:keys,fetchImpl:async(url)=>{
    calls.push(url);
    if(url.hostname==='restapi.amap.com')return new Response('',{status:503});
    if(url.hostname==='apis.map.qq.com')return Response.json({status:121,message:'quota tencent-secret'});
    assert.equal(url.hostname,'api.tianditu.gov.cn');assert.equal(url.searchParams.get('tk'),'tdt-secret');
    return Response.json({status:{infocode:1000},resultType:1,pois:[{hotPointID:'td-id',name:'故宫',address:'北京市东城区',lonlat:'116.397128,39.916527'}]});
  }});
  const r=await s.searchPlaces({query:'故宫',city:'北京'});assert.equal(r.provider,'tianditu');assert.equal(calls.length,3);
  assert.ok(Math.abs(r.places[0].lon-116.403372494)<1e-7);assert.equal(r.places[0].coordinateSystem,'gcj02');assert.doesNotMatch(JSON.stringify(r),/secret/);
  await s.searchPlaces({query:'咖啡',center:r.places[0].lon+','+r.places[0].lat,provider:'tianditu'});
  const request=JSON.parse(calls.at(-1).searchParams.get('postStr'));assert.equal(request.queryType,3);
  const [lon,lat]=request.pointLonlat.split(',').map(Number);assert.ok(Math.abs(lon-116.397128)<1e-7);assert.ok(Math.abs(lat-39.916527)<1e-7);
});
test('all unavailable map providers fail honestly without credential exposure',async()=>{
  const calls=[];
  const s=createLifeServices({env:keys,fetchImpl:async(url)=>{calls.push(url);return Response.json({status:121,message:'key=tencent-secret'});}});
  await assert.rejects(s.searchPlaces({query:'故宫',city:'北京',provider:'tencent'}),e=>!e.message.includes('tencent-secret'));
  assert.equal(calls.length,4);await assert.rejects(s.searchPlaces({query:'故宫',provider:'unknown'}),/来源/);assert.equal(calls.length,4);
});
test('requested Tencent falls back without asking, while daily quota avoids repeated requests',async()=>{
  let clock=Date.parse('2026-10-23T17:00:00+08:00');const calls=[];
  const s=createLifeServices({env:keys,now:()=>clock,fetchImpl:async url=>{
    calls.push(url.hostname);if(url.hostname==='apis.map.qq.com')return Response.json({status:121});
    return Response.json({status:'1',pois:[{id:'gd',name:'韶关学院',location:'113.6,24.7'}]});
  }});
  const a=await s.searchPlaces({query:'韶关学院',city:'韶关',provider:'tencent'});assert.equal(a.provider,'gaode');assert.match(a.fallback,/腾讯/);
  assert.match(a.fallback,/日额度耗尽/);assert.equal(a.fallbackReasons[0].code,'QUOTA');
  const cooled=await s.searchPlaces({query:'韶关学院校门',city:'韶关',provider:'tencent'});assert.equal(calls.filter(v=>v==='apis.map.qq.com').length,1);
  assert.match(cooled.fallback,/日额度耗尽/);assert.equal(cooled.fallbackReasons[0].code,'QUOTA');
  clock+=8*3600000;await s.searchPlaces({query:'韶关学院新查询',city:'韶关',provider:'tencent'});assert.equal(calls.filter(v=>v==='apis.map.qq.com').length,2);
});
test('Baidu takes over failed or quota-exhausted map services with GCJ output',async()=>{
  const calls=[];
  const s=createLifeServices({env:keys,fetchImpl:async url=>{
    calls.push(url);
    if(url.hostname==='restapi.amap.com')return Response.json({status:'0',infocode:'10003'});
    if(url.hostname==='apis.map.qq.com')return Response.json({status:121});
    if(url.hostname==='api.tianditu.gov.cn')return new Response('',{status:403});
    assert.equal(url.hostname,'api.map.baidu.com');assert.equal(url.searchParams.get('ret_coordtype'),'gcj02ll');assert.equal(url.searchParams.get('coord_type'),'2');
    return Response.json({status:0,results:[{uid:'bd1',name:'韶关学院',address:'韶关市',location:{lng:113.6,lat:24.7}}]});
  }});
  const r=await s.searchPlaces({query:'韶关学院',city:'韶关',provider:'tianditu'});assert.equal(r.provider,'baidu');assert.equal(r.places[0].lon,113.6);assert.equal(r.places[0].coordinateSystem,'gcj02');assert.equal(calls.length,4);assert.doesNotMatch(JSON.stringify(r),/secret/);
});
test('ambiguous center never falls through to a different provider',async()=>{
  let calls=0;
  const s=createLifeServices({env:keys,fetchImpl:async()=>{calls++;return Response.json({status:'1',pois:[{id:'a',name:'东站南广场',location:'120,30'},{id:'b',name:'东站北广场',location:'120.1,30.1'}]});}});
  await assert.rejects(s.searchPlaces({query:'咖啡',city:'杭州',center:'东站'}),e=>e.code==='AMBIGUOUS');assert.equal(calls,1);
});
test('MCP web_search reaches Yuanbao through the real tool handler without external network',async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(path.join(root,'scripts/search-provider-fixture.mjs')).href,path.join(root,'src/mcp-web-search-safe.js')],cwd:root,stderr:'pipe',env:{...process.env,BOCHA_API_KEY:'fixture-bocha',DEEPSEEK_API_KEY:'fixture-deepseek',YUANBAO_SEARCH_API_KEY:'fixture-yuanbao'}});
  const client=new Client({name:'search-fallback-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const response=await client.callTool({name:'web_search',arguments:{query:'公开资料',deep:false}});
    assert.equal(response.isError,undefined);
    const data=JSON.parse(response.content.find(v=>v.type==='text').text);assert.equal(data.source,'yuanbao-search');assert.equal(data.results[0].url,'https://example.com/official');assert.doesNotMatch(JSON.stringify(response),/fixture-yuanbao/);
  }finally{await client.close();}
});
