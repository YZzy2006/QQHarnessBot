import {test} from 'node:test';import assert from 'node:assert/strict';
import {createUtilityWeather} from '../src/utility-weather.js';import {createUtilityLibrary} from '../src/utility-library.js';
import {parseCompanionCommand} from '../src/companion.js';import {utilityFixture,ownerCtx} from './utility-test-fixture.mjs';
const group={...ownerCtx,sourceKey:'group:456',userId:'234',quotedId:'77'};
test('personal weather defaults never use another member or administrator city',async()=>{
  const f=utilityFixture({ownerCity:()=> '管理员私有城市'}),w=createUtilityWeather(f.d);
  try {
    await w.handle(group,parseCompanionCommand('[我的城市][广州]'),'');
    await w.handle(group,parseCompanionCommand('[天气][明天]'),'');
    assert.equal(f.queries.at(-1),'广州');
    const other={...group,userId:'345'};
    const count=f.queries.length;
    await w.handle(other,parseCompanionCommand('[天气][明天]'),'');
    assert.equal(f.queries.length,count);assert.match(f.sent.at(-1).text,/我的城市/);
    assert.equal(f.d.store.profile('345').city,'');
  }finally{f.close();}
});
test('weather followups and candidate choice isolate group actor and expire',async()=>{
  const f=utilityFixture(),w=createUtilityWeather(f.d);
  try {
    await w.handle(group,parseCompanionCommand('[天气查询][西湖区]'),'');
    assert.match(f.sent.at(-1).text,/选第二个/);
    assert.equal(await w.handle({...group,userId:'345'},null,'选第二个'),false);
    await w.handle(group,null,'选第二个');assert.equal(f.queries.at(-1),'南昌市西湖区');
    await w.handle(group,null,'那明天呢');assert.match(f.sent.at(-1).text,/明天天气/);
    f.advance(300001);assert.equal(await w.handle(group,null,'那明天呢'),false);
  }finally{f.close();}
});
test('group knowledge needs review, preserves source and prevents cross-group access or foreign delete',async()=>{
  const f=utilityFixture(),lib=createUtilityLibrary(f.d);const call=(ctx,s)=>lib.handle(ctx,parseCompanionCommand(s));
  try{
    await call(group,'[群知识投稿][启动方法]');const row=f.d.store.group(group.sourceKey).knowledge[0];
    await call(group,'[群知识][启动]');assert.doesNotMatch(f.sent.at(-1).text,/npm start/);
    await assert.rejects(call(group,'[群知识审核]['+row.id+'][通过]'),/管理员/);
    await call({...group,userId:'123'},'[群知识审核]['+row.id+'][通过]');
    await call(group,'[群知识][启动]');assert.match(f.sent.at(-1).text,/npm start/);assert.match(f.sent.at(-1).text,/消息77/);
    await call({...group,sourceKey:'group:789'},'[群知识][启动]');assert.doesNotMatch(f.sent.at(-1).text,/npm start/);
    await assert.rejects(call({...group,userId:'345'},'[删除群知识]['+row.id+'][确认]'),/本人/);
    await call({...group,userId:'123'},'[群知识过期]['+row.id+']');
    await call(group,'[群知识][启动]');assert.doesNotMatch(f.sent.at(-1).text,/npm start/);
  }finally{f.close();}
});
test('media collections isolate groups, store individual reviews and restrict deletion',async()=>{
  const f=utilityFixture(),lib=createUtilityLibrary(f.d),call=(ctx,s)=>lib.handle(ctx,parseCompanionCommand(s));
  try{
    await call(group,'[推荐歌曲][测试歌][https://example.com/song][推荐理由]');
    const id=f.d.store.group(group.sourceKey).media[0].id;
    await call(group,'[评价推荐]['+id+'][很好听]');
    await call({...group,userId:'345'},'[评价推荐]['+id+'][另一种评价]');
    assert.equal(f.d.store.group(group.sourceKey).media[0].reviews.length,2);
    await call(group,'[歌单]');assert.match(f.sent.at(-1).text,/很好听/);
    await call({...group,sourceKey:'group:789'},'[歌单]');assert.doesNotMatch(f.sent.at(-1).text,/测试歌/);
    await assert.rejects(call({...group,userId:'345'},'[删除推荐]['+id+'][确认]'),/本人/);
    await assert.rejects(call(group,'[推荐电影][测试][file:///secret]'),/公开/);
  }finally{f.close();}
});
