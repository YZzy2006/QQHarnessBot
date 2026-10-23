import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCompanion} from '../src/companion.js';
import {createUtilities} from '../src/utilities.js';
import {utilityFixture,ownerCtx} from './utility-test-fixture.mjs';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createLifeServices} from '../src/life-services.js';

const member={sourceKey:'group:456',userId:'234',directed:true};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function placeFixture(overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-continuity-'));
  let clock=Date.parse('2026-10-23T12:00:00+08:00');const sent=[],cards=[],queries=[];
  const places=[1,2].map(i=>({id:'poi_'+i,name:'校区'+i,address:'路'+i,lat:24+i/100,lon:113,provider:'gaode',source:'高德地图'}));
  const d={stateDir:dir,ownerQQ:()=>123,now:()=>clock,isAllowed:()=>true,redact:String,
    send:async(key,text)=>{sent.push({key,text});return true;},sendLocation:async(key,p)=>{cards.push({key,...p});return true;},
    life:{searchPlaces:async o=>{queries.push(o);return {source:'高德地图',provider:'gaode',places,queriedAt:clock,note:'搜索候选'};},resolvePlace:async(q,city,o)=>{
      queries.push({query:q,city,...o});return {...places[0],name:q};}},...overrides};
  return {c:createCompanion(d),d,sent,cards,queries,places,advance:ms=>clock+=ms,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('place choices and provider followups preserve query, actor and read-only intent',async()=>{
  const f=placeFixture();
  try{
    await f.c.handle(member,'[找店][韶关][学校]');
    assert.equal(await f.c.handle(member,'换腾讯的'),true);
    assert.equal(f.queries.at(-1).provider,'tencent');assert.equal(f.queries.at(-1).query,'学校');
    assert.equal(f.cards.length,0);
    await f.c.handle(member,'选第二个');assert.match(f.sent.at(-1).text,/校区2/);assert.equal(f.cards.length,0);
    await f.c.handle(member,'发这个');assert.equal(f.cards.length,1);assert.equal(f.cards[0].id,'poi_2');
    assert.equal(f.cards[0].key,'group:456');
    assert.equal(await f.c.handle({...member,userId:'345'},'发这个'),false);
    assert.equal(await f.c.handle({...member,sourceKey:'group:789'},'发这个'),false);
    f.advance(300001);assert.equal(await f.c.handle(member,'换百度的'),false);
    assert.equal(fs.existsSync(path.join(f.d.stateDir,'companion.json')),false);
  }finally{f.close();}
});
test('ambiguous location request retains candidates and selected candidate completes original card request',async()=>{
  const f=placeFixture({life:{resolvePlace:async q=>{
    if(q==='学院')throw Object.assign(Error('地点有多个匹配'),{code:'AMBIGUOUS',candidates:['学院东校区','学院西校区']});
    return {id:'west',name:q,address:'大学路',lat:24,lon:113,source:'高德地图',provider:'gaode'};
  }}});
  try{
    await f.c.handle(member,'[位置][学院][韶关]');assert.match(f.sent.at(-1).text,/选第二个/);
    await f.c.handle(member,'选第二个');assert.equal(f.cards.length,1);assert.equal(f.cards[0].name,'学院西校区');
    assert.match(f.sent.at(-1).text,/已提交/);
    f.d.sendLocation=async()=>false;
    await f.c.handle(member,'还是刚才那个');assert.match(f.sent.at(-1).text,/未确认送达|失败/);
  }finally{f.close();}
});
test('busy weather requests queue followups and finish both without another model turn',async()=>{
  const gate=deferred(),entered=deferred();let first=true;
  const f=utilityFixture(),original=f.d.life.weather;
  f.d.life.weather=async city=>{if(first){first=false;entered.resolve();await gate.promise;}return original(city);};
  const u=createUtilities(f.d);
  try{
    const a=u.handle(ownerCtx,'[天气查询][广州]');await entered.promise;
    const b=u.handle(ownerCtx,'那明天呢');
    await Promise.resolve();gate.resolve();
    assert.deepEqual(await Promise.all([a,b]),[true,true]);
    assert.deepEqual(f.queries,['广州','广州']);
    assert.ok(f.sent.some(v=>/已排队/.test(v.text)));
    assert.match(f.sent.at(-1).text,/明天天气/);
  }finally{gate.resolve();f.close();}
});
test('request queue is bounded, expires pending work and drains after failed operation',async()=>{
  const {createLocalRequestQueue}=await import('../src/local-request-queue.js');
  let clock=1000;const q=createLocalRequestQueue({now:()=>clock,maxPending:1,ttlMs:100});
  const gate=deferred(),entered=deferred();let queued=0,ran=false;
  const a=q.run('actor',async()=>{entered.resolve();await gate.promise;throw Error('first failed');});
  const firstResult=a.catch(e=>e.message);await entered.promise;
  const b=q.run('actor',async()=>{ran=true;},{onQueued:async()=>queued++});const secondResult=b.catch(e=>e.code);
  await assert.rejects(q.run('actor',async()=>{}),e=>e.code==='QUEUE_FULL');
  assert.equal(await q.run('another',async()=>7),7);
  clock+=101;gate.resolve();
  assert.equal(await firstResult,'first failed');assert.equal(await secondResult,'QUEUE_EXPIRED');
  assert.equal(queued,1);assert.equal(ran,false);assert.equal(q.busy('actor'),false);
});
test('place lookup queues a short followup during query and reports query failure before next request',async()=>{
  const gate=deferred(),entered=deferred(),f=placeFixture();
  const search=f.d.life.searchPlaces;let first=true;
  f.d.life.searchPlaces=async o=>{if(first){first=false;entered.resolve();await gate.promise;}return search(o);};
  try{
    const a=f.c.handle(member,'[找店][韶关][学校]');await entered.promise;
    const b=f.c.handle(member,'选第二个');gate.resolve();
    assert.deepEqual(await Promise.all([a,b]),[true,true]);
    assert.ok(f.sent.some(v=>/已排队/.test(v.text)));assert.match(f.sent.at(-1).text,/校区2/);
    f.d.life.searchPlaces=async()=>{throw Error('地图暂不可用');};
    await f.c.handle(member,'换百度的');assert.match(f.sent.at(-1).text,/未完成.*地图暂不可用/);
    f.d.life.searchPlaces=search;
    await f.c.handle(member,'换腾讯的');assert.match(f.sent.at(-1).text,/地点查询/);
  }finally{gate.resolve();f.close();}
});
test('model-seeded card intent continues through actual-source fallback without losing card delivery',async()=>{
  const f=placeFixture();
  try{
    await f.c.queryPlaces(member,{query:'学院',city:'韶关',sendRequested:true});
    const search=f.d.life.searchPlaces;
    f.d.life.searchPlaces=async o=>({...await search(o),fallback:'腾讯地图日额度耗尽，已改用高德地图'});
    await f.c.handle(member,'换腾讯的');
    assert.equal(f.cards.length,2);assert.match(f.sent.at(-1).text,/已提交2张/);
    assert.match(f.sent.at(-1).text,/腾讯地图日额度耗尽.*高德地图/);
    assert.equal(f.queries.at(-1).provider,'tencent');
  }finally{f.close();}
});
test('queued utility operations drain after failure and recheck disabled state before execution',async()=>{
  const gate=deferred(),entered=deferred();let enabled=true;
  const f=utilityFixture({isEnabled:()=>enabled,search:async()=>{entered.resolve();await gate.promise;throw Error('检索暂不可用');}}),u=createUtilities(f.d);
  try{
    const a=u.handle(ownerCtx,'[兴趣简报][Java]');await entered.promise;
    const b=u.handle(ownerCtx,'[我的设置]');gate.resolve();await Promise.all([a,b]);
    assert.ok(f.sent.some(v=>/未完成.*检索暂不可用/.test(v.text)));
    assert.match(f.sent.at(-1).text,/我的设置/);
    enabled=false;const count=f.sent.length;
    assert.equal(await u.handle(ownerCtx,'[我的设置]'),false);assert.equal(f.sent.length,count);
  }finally{gate.resolve();f.close();}
});
test('a new model lookup cannot be overwritten by an older late query response',async()=>{
  const gate=deferred(),entered=deferred(),f=placeFixture();
  f.d.life.searchPlaces=async o=>{
    if(o.query==='旧查询'){entered.resolve();await gate.promise;}
    return {source:'高德地图',places:[{...f.places[0],id:o.query}]};
  };
  try{
    const a=f.c.queryPlaces(member,{query:'旧查询'});await entered.promise;
    await f.c.queryPlaces(member,{query:'新查询'});gate.resolve();await a;
    assert.equal(f.c.placeContext(member).options.query,'新查询');
    assert.equal(f.c.selectedPlace(member,'新查询').id,'新查询');
    assert.throws(()=>f.c.selectedPlace(member,'旧查询'),/地点ID不在/);
  }finally{gate.resolve();f.close();}
});
test('real inbound map continuation stays in source group and never creates a model prompt',async()=>{
  const requested=[];
  const h=await bridgeHarness({config:{allow:{private:['123','234'],groups:['456']},sendDelayMinMs:0,sendDelayMaxMs:0},globals:{
    createLifeServices:()=>({status:()=>({}),searchPlaces:async o=>{
      requested.push(o);return {provider:'gaode',source:'高德地图',queriedAt:Date.now(),places:[{id:'campus',name:'校区',address:'大学路',lat:24,lon:113,provider:'gaode',source:'高德地图'}]};
    },weather:async()=>{throw Object.assign(Error('多个地区'),{code:'AMBIGUOUS',candidates:['杭州西湖区','南昌西湖区']});}})
  }});
  h.setMode('reserved2');let seq=70000;
  const command=async text=>h.handleIncoming('group',456,{user_id:234,group_id:456,self_id:h.calls.selfUin,sender:{nickname:'群友'},message_id:seq++,message:[{type:'text',data:{text}}]},h.cfg);
  try{
    await h.companion.queryPlaces(member,{query:'学院',city:'韶关'});
    await command('换腾讯的');await command('选第一个');await command('发这个');
    assert.equal(requested.at(-1).provider,'tencent');assert.equal(h.calls.prompts.length,0);
    assert.ok(h.calls.sent.some(v=>v.kind==='group'&&v.id===456&&v.segments[0]?.type==='json'));
    await command('[天气查询][西湖区]');
    // The newest weather candidates must own a bare candidate selection.
    const maps=requested.length;await command('选第二个');
    assert.equal(requested.length,maps);assert.equal(h.calls.prompts.length,0);
    await h.companion.queryPlaces(member,{query:'新学院',city:'韶关'});
    await command('选第一个');assert.match(h.calls.sent.at(-1).text,/校区/);
    assert.ok(h.calls.sent.every(v=>v.kind==='group'));
  }finally{await h.close();}
});
test('context ordering remains deterministic when weather and map have identical millisecond times',async()=>{
  const f=placeFixture(),u=utilityFixture();
  const weather=createUtilities({...u.d,now:f.d.now});
  try{
    await weather.handle(member,'[天气查询][广州]');
    await f.c.queryPlaces(member,{query:'学院'});
    const w=weather.weather.context(member),p=f.c.placeContext(member);
    assert.equal(w.at,p.at);assert.ok(p.order>w.order);
    weather.weather.rememberQuery(member,'杭州','今天');assert.ok(weather.weather.context(member).order>p.order);
  }finally{f.close();u.close();}
});
test('a queued operation disabled before execution gets a cancellation receipt',async()=>{
  const gate=deferred(),entered=deferred();let enabled=true;
  const f=utilityFixture({isEnabled:()=>enabled,search:async()=>{entered.resolve();await gate.promise;return {source:'fixture',results:[]};}}),u=createUtilities(f.d);
  try{
    const a=u.handle(ownerCtx,'[兴趣简报][Java]');await entered.promise;
    const b=u.handle(ownerCtx,'[我的设置]');enabled=false;gate.resolve();
    await Promise.all([a,b]);assert.match(f.sent.at(-1).text,/尚未执行.*已关闭/);
    assert.equal(f.sent.filter(v=>/^【我的设置】/.test(v.text)).length,0);
  }finally{gate.resolve();f.close();}
});
test('late ambiguous resolution cannot replace a newer query or send its old candidate',async()=>{
  const entered=deferred(),gate=deferred(),f=placeFixture();
  f.d.life.resolvePlace=async()=>{entered.resolve();await gate.promise;throw Object.assign(Error('多个地点'),{code:'AMBIGUOUS',candidates:['旧东校区','旧西校区']});};
  try{
    const a=f.c.handle(member,'[位置][旧学院][韶关]');await entered.promise;
    await f.c.queryPlaces(member,{query:'新学院'});gate.resolve();await a;
    assert.equal(f.c.placeContext(member).options.query,'新学院');
    assert.equal(f.cards.length,0);assert.match(f.sent.at(-1).text,/已被更新/);
  }finally{gate.resolve();f.close();}
});
test('failed provider change preserves the last valid selection without pretending a new source succeeded',async()=>{
  const f=placeFixture();
  try{
    await f.c.handle(member,'[找店][韶关][学校]');await f.c.handle(member,'选第二个');
    f.d.life.searchPlaces=async()=>{throw Error('所有地图暂不可用');};
    await f.c.handle(member,'换腾讯的');assert.match(f.sent.at(-1).text,/未完成.*所有地图暂不可用/);
    await f.c.handle(member,'发这个');assert.equal(f.cards.length,1);assert.equal(f.cards[0].id,'poi_2');
    assert.match(f.sent.at(-1).text,/来源：高德地图/);
  }finally{f.close();}
});
test('a single candidate accepts a direct pronoun without an unnecessary choice round',async()=>{
  const f=placeFixture();
  f.d.life.searchPlaces=async()=>({source:'高德地图',places:[f.places[0]]});
  try{
    await f.c.queryPlaces(member,{query:'学院'});
    await f.c.handle(member,'发这个');assert.equal(f.cards.length,1);assert.equal(f.cards[0].id,'poi_1');
    assert.match(f.sent.at(-1).text,/已提交位置卡片/);
  }finally{f.close();}
});

test('Baidu card followed by a real inbound Tencent request still sends the quota fallback card',async()=>{
  for(const kind of ['private','group']) {
    const upstream=[];
    const life=createLifeServices({env:{BAIDUDITU_API_KEY:'fixture-baidu',TENGXUNDITU_API_KEY:'fixture-tencent',GAODE_WEB_API_KEY:'fixture-gaode'},fetchImpl:async url=>{
      upstream.push(url.hostname);
      if(url.hostname==='api.map.baidu.com')return Response.json({status:0,results:[{uid:'campus',name:'韶关学院',address:'大学路',location:{lat:24.77,lng:113.66}}]});
      if(url.hostname==='apis.map.qq.com')return Response.json({status:121});
      assert.equal(url.hostname,'restapi.amap.com');
      return Response.json({status:'1',pois:[{id:'campus',name:'韶关学院',address:'大学路',location:'113.66,24.77'}]});
    }});
    const h=await bridgeHarness({config:{allow:{private:['123','234'],groups:['456']},sendDelayMinMs:0,sendDelayMaxMs:0},globals:{createLifeServices:()=>life}});
    h.setMode('reserved2');
    const userId=234,key=kind==='private'?'private:234':'group:456',ctx={sourceKey:key,userId:String(userId)};
    const server=h.startConsoleServer();
    if(!server.listening)await new Promise(r=>server.once('listening',r));
    try {
      const text='发韶关学院位置卡片，百度地图';
      h.appendSocialV2Message(key,'用户',text,text,false,false,'910000',[],String(userId));
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/life`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-token':h.getSocialV2State(key).agentToken,'x-agent-call':'1'},body:JSON.stringify({key,action:'places',query:'韶关学院',city:'韶关',nearby:false,provider:'baidu',requestText:text})});
      const result=await response.json();
      assert.equal(response.status,200,JSON.stringify(result));
      assert.equal(result.provider,'baidu');assert.equal(result.delivery.status,'submitted');
      assert.equal(h.calls.sent.filter(v=>v.segments[0]?.type==='json').length,1);
      h.calls.sent.length=0;
      await h.handleIncoming(kind,kind==='private'?userId:456,{user_id:userId,group_id:kind==='group'?456:undefined,self_id:h.calls.selfUin,sender:{nickname:'群友'},message_id:910001,message:[{type:'text',data:{text:'发个腾讯地图的'}}]},h.cfg);
      const cards=h.calls.sent.filter(v=>v.segments[0]?.type==='json');
      assert.equal(cards.length,1,'a previous Baidu card must not suppress this fallback card');
      const card=JSON.parse(cards[0].segments[0].data.data);
      assert.equal(card.view,'LocationShare');assert.equal(card.meta['Location.Search'].name,'韶关学院');
      assert.equal(card.meta['Location.Search'].lat,'24.77');assert.equal(card.meta['Location.Search'].lng,'113.66');
      assert.ok(h.calls.sent.every(v=>v.kind===kind&&v.id===(kind==='private'?userId:456)));
      assert.match(h.calls.sent.map(v=>v.text).join('\n'),/已提交1张.*高德地图[\s\S]*腾讯地图日额度耗尽/);
      assert.equal(h.companion.placeContext(ctx).options.provider,'tencent');
      assert.equal(h.companion.placeContext(ctx).places[0].provider,'gaode');
      assert.deepEqual(upstream,['api.map.baidu.com','apis.map.qq.com','restapi.amap.com']);
      assert.equal(h.calls.prompts.length,0);
    }finally{await new Promise(r=>server.close(r));await h.close();}
  }
});
