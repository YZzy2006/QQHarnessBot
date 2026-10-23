import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNewsSearch,normalizeNews} from '../src/utility-news.js';import {createUtilities} from '../src/utilities.js';
import {utilityFixture,ownerCtx} from './utility-test-fixture.mjs';
test('news filters old/future/unsafe results, de-duplicates URLs and labels unknown dates',()=>{
  const now=Date.parse('2026-10-23T09:00:00+08:00');
  const rows=normalizeNews([
    {title:'新版本',url:'https://example.com/new',date:'2026-10-22',snippet:'发布'},
    {title:'重复',url:'https://example.com/new',date:'2026-10-22'},
    {title:'旧闻',url:'https://example.com/old',date:'2020-01-01'},
    {title:'未来',url:'https://example.com/future',date:'2030-01-01'},
    {title:'无日期',url:'https://example.com/no-date'},
    {title:'非法',url:'file:///secret'}
  ],now);
  assert.equal(rows.length,2);assert.equal(rows[1].dateLabel,'未提供发布时间');
});
test('news search uses configured credentials without exposing upstream secrets',async()=>{
  let body;
  const search=createNewsSearch({env:{BOCHA_API_KEY:'private-key'},fetchImpl:async(url,opts)=>{body=JSON.parse(opts.body);return Response.json({code:200,data:{webPages:{value:[{name:'消息',url:'https://example.com',snippet:'摘要',datePublished:'2026-10-22'}]}}});}});
  const r=await search('Java');
  assert.equal(r.source,'bocha');assert.equal(body.count,8);assert.equal(JSON.stringify(r).includes('private-key'),false);
  await assert.rejects(createNewsSearch({env:{},readKey:()=>'',fetchImpl:async()=>{throw Error('secret');}})('Java'),/检索/);
});
test('subscriptions are opt-in, respect quiet/pause gates, retry failures and stop when closed',async()=>{
  let fail=true,allowed=true;
  const f=utilityFixture({ownerFacts:()=>({}),send:async(key,text,options)=>{if(fail)return false;f.sent.push({key,text,...options});return true;},canNotify:()=>allowed});
  const u=createUtilities(f.d);
  try{
    await u.tick();assert.equal(f.sent.length,0);
    fail=false;await u.handle(ownerCtx,'[今日安排订阅][09:00]');f.sent.length=0;
    allowed=false;await u.tick();assert.equal(f.sent.length,0);
    allowed=true;fail=true;await u.tick();assert.equal(f.sent.length,0);
    fail=false;f.advance(121000);await u.tick();assert.equal(f.sent.filter(v=>v.text.includes('【今日安排】')).length,1);
    await u.tick();assert.equal(f.sent.filter(v=>v.text.includes('【今日安排】')).length,1);
    await u.handle(ownerCtx,'[今日安排订阅][关闭]');f.sent.length=0;f.advance(86400000);await u.tick();assert.equal(f.sent.length,0);
  }finally{f.close();}
});
test('weekly subscription rejects non-owner and commands never write original reminders',async()=>{
  const f=utilityFixture({send:async()=>true,canNotify:()=>true}),u=createUtilities(f.d);
  try{
    await u.handle({...ownerCtx,userId:'234',sourceKey:'private:234'},'[周记订阅][周日20:00]');
    assert.equal(f.d.store.profile('234').subscriptions.weekly,undefined);
    assert.equal(u.store.file.endsWith('utilities.json'),true);
  }finally{f.close();}
});
test('closing a subscription during retrieval suppresses the pending result',async()=>{
  let release;const gate=new Promise(r=>{release=r;});
  const f=utilityFixture({send:async(key,text)=>{f.sent.push({key,text});return true;},canNotify:()=>true,search:async()=>{await gate;return {source:'fixture',results:[]};}});
  const u=createUtilities(f.d);
  try{
    await u.handle(ownerCtx,'[兴趣主题][Java]');await u.handle(ownerCtx,'[简报订阅][09:00]');f.sent.length=0;
    const work=u.tick();await u.handle(ownerCtx,'[简报订阅][关闭]');release();await work;
    assert.equal(f.sent.some(v=>v.text.includes('【兴趣简报】')),false);
  }finally{release?.();f.close();}
});
