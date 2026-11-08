import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createCompanion } from '../src/companion.js';
import { bjDate } from '../src/life-services.js';
import { createLifeServices } from '../src/life-services.js';
const OWNER = 123, GROUP = 456, FRIEND = 234;
let seq = 800;
async function fixture({ weatherError, weatherErrorCode, weatherErrorCandidates,searchPlacesImpl,resolvePlaceImpl } = {}) {
  const weather = { source: '和风天气', provider: 'hefeng', city: '杭州市西湖区', queriedAt: Date.now(), current: { text: '晴', temp: 20 },
    days: [0, 1, 2].map((n) => ({ date: bjDate(Date.now() + n * 86400000), min: 10, max: 20, day: '晴', night: '多云' })), hours: [], limitations: [], attribution: 'https://developer.qweather.com/attribution.html' };
  const places = { source: '高德地图', queriedAt: Date.now(), center: { name: '东站' }, radius: 2000, note: '直线距离', places: [{ id: 'poi_abc', name: '咖啡店', address: '一号路', lat: 30, lon: 120, url: 'https://uri.amap.com/marker?position=120,30', distance: 100 }] };
  const h = await bridgeHarness({ config: { allow: { private: [String(OWNER), String(FRIEND)], groups: [String(GROUP)] }, sendDelayMinMs: 0, sendDelayMaxMs: 0,
    sendLimits: { private: { perMinute: 300, perHour: 1000, perDay: 2000 }, group: { perMinute: 300, perHour: 1000, perDay: 2000 } } }, globals: {
      createLifeServices: () => ({ weather: async () => { if (weatherError) throw Object.assign(new Error(weatherError), { code: weatherErrorCode, candidates: weatherErrorCandidates }); return weather; }, searchPlaces: searchPlacesImpl|| (async () => places), resolvePlace:resolvePlaceImpl|| (async () => places.places[0]), status: () => ({}) }),
      createCompanion: (d) => createCompanion({ ...d, compose: async () => '一起慢慢来呀。' })
    } });
  h.setMode('reserved2');
  h.command = async (text, { user = OWNER, kind = 'private', quote, message } = {}) => {
    h.calls.sent.length = 0;
    const id = kind === 'group' ? GROUP : user;
    await h.handleIncoming(kind, id, { user_id: user, group_id: kind === 'group' ? id : undefined, self_id: h.calls.selfUin, sender: { nickname: String(user) }, message_id: seq++, message: message || [...(quote ? [{ type: 'reply', data: { id: quote } }] : []), { type: 'text', data: { text } }] }, h.cfg);
    return h.calls.sent.map((m) => m.text).join('\n');
  };
  return h;
}
test('standard weather query supports explicit regions and dates and replies in the source conversation', async () => {
  const h = await fixture();
  try {
    for (const user of [OWNER, FRIEND]) {
      for (const kind of ['group', 'private']) {
        assert.match(await h.command('[天气查询][广东省广州市]', { user, kind }), /今天天气/);
        assert.ok(h.calls.sent.length > 0 && h.calls.sent.every((m) => m.kind === kind && String(m.id) === String(kind === 'group' ? GROUP : user)));
        assert.match(await h.command('[天气查询][广东省广州市天河区][明天]', { user, kind }), /明天天气/);
        assert.ok(h.calls.sent.every((m) => m.kind === kind && !m.text.includes('已私聊')));
      }
    }
  } finally { await h.close(); }
});
test('weather usage errors show complete copyable examples instead of generic companion help', async () => {
  const h = await fixture();
  try {
    for (const input of ['[天气查询]', '[天气查询][明天]', '[天气查询][广州][后天]', '[天气查询][广州][明天][多余参数]']) {
      const reply = await h.command(input, { kind: 'group' });
      assert.match(reply, /\[天气查询\]\[广东省广州市\]/);
      assert.match(reply, /\[天气查询\]\[广东省广州市天河区\]\[明天\]/);
      assert.ok(h.calls.sent.length > 0 && h.calls.sent.every((m) => m.kind === 'group'));
      assert.doesNotMatch(reply, /和风天气/);
    }
    assert.match(await h.command('[天气][明天]', { kind: 'group', user: FRIEND }), /\[天气查询\]\[广东省广州市\]/);
  } finally { await h.close(); }
});
test('ambiguous weather queries retain candidates and explain exactly how to refine the region', async () => {
  const h = await fixture({ weatherError: '地点有多个匹配：杭州市西湖区；南昌市西湖区', weatherErrorCode: 'AMBIGUOUS', weatherErrorCandidates: ['杭州市西湖区', '南昌市西湖区'] });
  try {
    for (const input of ['[天气查询][西湖区]', '[天气][西湖区]']) {
      const reply = await h.command(input, { kind: 'group' });
      assert.match(reply, /杭州市西湖区.*南昌市西湖区/);
      assert.match(reply, /\[天气查询\]\[广东省广州市天河区\]\[明天\]/);
      assert.match(reply, /\[天气查询\]\[杭州市西湖区\]/);
      assert.ok(h.calls.sent.length > 0 && h.calls.sent.every((m) => m.kind === 'group'));
    }
  } finally { await h.close(); }
});
test('weather replies stay in the requesting conversation for owners and group members', async () => {
  const h = await fixture();
  try {
    for (const user of [OWNER, FRIEND]) {
      const text = '清远今天天气怎么样';
      await h.command('', { kind: 'group', user, message: [
        { type: 'at', data: { qq: String(h.calls.selfUin) } }, { type: 'text', data: { text } }
      ] });
      assert.ok(h.calls.sent.length > 0);
      assert.ok(h.calls.sent.every((m) => m.kind === 'group'), `group weather for ${user} must not send a private reply`);
      assert.match(h.calls.sent.map((m) => m.text).join('\n'), /和风天气/);
      assert.ok(h.calls.sent.every((m) => !m.text.includes('已私聊')));
      await h.command('[天气][清远][明天]', { kind: 'group', user });
      assert.ok(h.calls.sent.length > 0 && h.calls.sent.every((m) => m.kind === 'group'));
      assert.match(h.calls.sent.map((m) => m.text).join('\n'), /明天天气/);
      await h.command('[天气][清远][今天]', { user });
      assert.ok(h.calls.sent.length > 0 && h.calls.sent.every((m) => m.kind === 'private'));
    }
  } finally { await h.close(); }
});
test('group weather errors return to the group without a private detour', async () => {
  const h = await fixture({ weatherError: '天气暂不可用' });
  try {
    for (const user of [OWNER, FRIEND]) {
      assert.match(await h.command('[天气][清远][今天]', { kind: 'group', user }), /天气暂不可用/);
      assert.ok(h.calls.sent.length > 0 && h.calls.sent.every((m) => m.kind === 'group'));
      assert.ok(h.calls.sent.every((m) => !m.text.includes('私聊')));
    }
  } finally { await h.close(); }
});
test('private/group companion commands, focus guard and old tasks remain separate', async () => {
  const h = await fixture();
  try {
    h.getReminders().set('private:123', [{ id: 'r_aaaaaaaa', at: Date.now() + 86400000, text: '原有任务', kind: 'ownerTask' }]); h.saveReminders(true);
    const before = fs.readFileSync(path.join(h.temp, 'state/reminders.json'), 'utf8');
    assert.match(await h.command('[陪伴帮助]'), /时光胶囊/);
    assert.match(await h.command('[天气城市][杭州西湖区]'), /和风天气/);
    assert.match(await h.command('[天气][明天]'), /明天天气/);
    assert.match(await h.command('陪我写代码半小时'), /我陪你/);
    const blocked = await h.sendWakePromptV2('private:123', 'proactiveCheck'); assert.equal(blocked.skipped, true); assert.match(blocked.error, /专注/);
    await h.command('[时光胶囊][一个月后][给未来的自己][附言]', { kind: 'group' });
    assert.ok(h.calls.sent.filter((m) => m.kind === 'group').every((m) => !m.text.includes('给未来的自己')));
    assert.equal(h.companion.profile().capsules.length, 1);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/reminders.json'), 'utf8'), before);
    const prompt = await h.buildWakePromptV2('private:123', 'replyCheck'); assert.match(prompt, /qq_weather/); assert.match(prompt, /同一发言人/);
  } finally { await h.close(); }
});
test('group member weather and places respond in source group; positions do not cross actors', async () => {
  const h = await fixture();
  try {
    assert.match(await h.command('[天气][杭州][明天]', { kind: 'group', user: FRIEND }), /和风天气/);
    assert.ok(h.calls.sent.every((m) => m.kind === 'group'));
    await h.command('', { kind: 'group', user: FRIEND, message: [{ type: 'location', data: { lat: 30, lon: 120, title: '东站' } }] });
    assert.ok(h.companion.locationFor({ sourceKey: 'group:456', userId: FRIEND }));
    assert.equal(h.companion.locationFor({ sourceKey: 'group:456', userId: OWNER }), null);
    assert.match(await h.command('[附近][咖啡]', { kind: 'group', user: FRIEND }), /咖啡店/);
    h.calls.getMessageData['99'] = { group_id: GROUP, sender: { nickname: '群友', user_id: FRIEND }, message: [{ type: 'text', data: { text: '回忆原话' } }], time: Math.floor(Date.now() / 1000) };
    await h.command('[记住这一刻][备注]', { kind: 'group', quote: '99' });
    assert.equal(h.companion.profile().memories[0].text, '回忆原话');
    assert.ok(h.calls.sent.filter((m) => m.kind === 'group').every((m) => !m.text.includes('回忆原话')));
  } finally { await h.close(); }
});
test('global pause stops automatic notifications but administrator commands still respond', async () => {
  const h = await fixture();
  try {
    h.socialV2.paused = true;
    assert.match(await h.command('[陪伴帮助]'), /时光胶囊/);
    assert.match(await h.command('[专注状态]', { kind: 'group' }), /没有专注计时/);
    assert.ok(h.calls.sent.some((m) => m.kind === 'group' && m.text.includes('已私聊')));
    assert.equal(await h.sendCompanionMessage('private:123', '自动提醒'), false);
  } finally { await h.close(); }
});
test('MCP HTTP checks token binding, recent request proof, sender positions and share result IDs', async () => {
  const h = await fixture(); let server;
  try {
    const key = 'group:456', st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, '群友', '东站附近有什么咖啡店', '东站附近有什么咖啡店', false, false, '901', [], FRIEND);
    server = h.startConsoleServer(); if (!server.listening) await new Promise((r) => server.once('listening', r));
    const call = async (body, token = st.agentToken) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/life`, { method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'x-agent-call': '1', 'content-type': 'application/json' }, body: JSON.stringify({ key, ...body }) });
      return { status: r.status, data: await r.json() };
    };
    assert.equal((await call({ action: 'places', query: '咖啡' }, 'bad')).status, 403);
    assert.equal((await call({ action: 'places', query: '咖啡', requestText: '不存在的请求' })).status, 403);
    assert.equal((await call({ action: 'places', query: '咖啡', center: '其他人家', requestText: '东站附近有什么咖啡店' })).status, 403);
    const result = await call({ action: 'places', query: '咖啡', center: '东站', requestText: '东站附近有什么咖啡店' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    h.appendSocialV2Message(key, '群友', '我现在在东站', '我现在在东站', false, false, '903', [], FRIEND);
    h.appendSocialV2Message(key, '另一位', '我现在在陌生站', '我现在在陌生站', false, false, '904', [], 345);
    h.appendSocialV2Message(key, '群友', '附近有什么咖啡店', '附近有什么咖啡店', false, false, '905', [], FRIEND);
    assert.equal((await call({ action: 'places', query: '咖啡', center: '东站', requestText: '附近有什么咖啡店' })).status, 200);
    assert.equal((await call({ action: 'places', query: '咖啡', center: '陌生站', requestText: '附近有什么咖啡店' })).status, 403);
    h.appendSocialV2Message(key, '群友', '把位置发给我', '把位置发给我', false, false, '902', [], FRIEND);
    const sent = await call({ action: 'send-location', placeId: 'poi_abc', requestText: '把位置发给我' });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const foreignToken = h.getSocialV2State('private:234').agentToken;
    assert.equal((await call({ action: 'places', query: '咖啡', requestText: '东站附近有什么咖啡店' }, foreignToken)).status, 403);
    h.cfg.socialV2.tools.lifeServices = false;
    assert.equal((await call({ action: 'places', query: '咖啡', requestText: '东站附近有什么咖啡店' })).status, 403);
  } finally { if (server) await new Promise((r) => server.close(r)); await h.close(); }
});

test('location sends a complete QQ map card in private and group, without raw links', async () => {
  const h = await fixture();
  try {
    for (const key of ['private:123', 'group:456']) for(const provider of ['gaode','tencent','tianditu','baidu']) {
      h.calls.sent.length = 0;
      assert.equal(await h.sendCompanionLocation(key, { id:'poi_abc',provider, name:'石牌校区', address:'广州市天河区', lat:23.139346, lon:113.352067, url:'https://uri.amap.com/marker?position=113.352067%2C23.139346' }), true);
      assert.equal(h.calls.sent.length, 1);
      const sent=h.calls.sent[0];
      assert.equal(sent.kind,key.split(':')[0]);assert.equal(String(sent.id),key.split(':')[1]);
      assert.equal(sent.segments.length,1);assert.equal(sent.segments[0].type,'json');
      const card=JSON.parse(sent.segments[0].data.data);
      assert.equal(card.app,'com.tencent.map');assert.equal(card.view,'LocationShare');
      assert.equal(card.meta['Location.Search'].name,'石牌校区');
      assert.equal(Number(card.meta['Location.Search'].lat),23.139346);
      assert.equal(Number(card.meta['Location.Search'].lng),113.352067);
      assert.equal(card.meta['Location.Search'].address,'广州市天河区');
      assert.equal(card.config.type,'card');assert.ok(card.ver);
      assert.doesNotMatch(JSON.stringify(sent.segments),/uri\.amap\.com/);
    }
  } finally { await h.close(); }
});

test('a rejected location card never falls back to sending a long map URL or reports success', async () => {
  const h=await fixture();
  try {
    h.calls.locationSendFailure=true;
    await assert.rejects(h.sendCompanionLocation('group:456',{id:'poi_abc',name:'咖啡店',address:'一号路',lat:30,lon:120,url:'https://uri.amap.com/marker?position=120,30'}),/位置卡片.*未确认送达/);
    assert.equal(h.calls.sent.length,0);
  } finally {await h.close();}
});

test('plain text tool cannot substitute an Amap marker link for a location card', async () => {
  const h=await fixture();let server;
  try {
    const key='group:456',st=h.getSocialV2State(key);
    server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
    const before=JSON.stringify(st.sendTimes);
    for(const endpoint of ['send-message','send-burst']) for(const link of ['https://uri.amap.com/marker?position=113.352067%2C23.139346&name=校区','https://apis.map.qq.com/uri/v1/marker?marker=coord:23,113','https://map.tianditu.gov.cn/?center=113,23','https://api.map.baidu.com/marker?location=23,113']) {
      const r=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${endpoint}`,{method:'POST',headers:{'x-console-token':'fixture-console-token','x-agent-token':st.agentToken,'x-agent-call':'1','content-type':'application/json'},body:JSON.stringify({key,messages:['这个位置\n'+link]})});
      const body=await r.json();assert.equal(body.ok,false);assert.match(body.error,/qq_send_location/);
      assert.equal(r.status,400);assert.equal(JSON.stringify(st.sendTimes),before);
    }
    assert.equal(h.calls.http.filter(v=>v.url.endsWith('/send_group_msg')).length,0);
    assert.equal(h.calls.sent.length,0);
  } finally {if(server)await new Promise(r=>server.close(r));await h.close();}
});

test('queued location respects changed permissions and invalid coordinates never send',async()=>{
  const h=await fixture();
  try {
    const place={name:'咖啡店',address:'一号路',lat:30,lon:120,url:'https://uri.amap.com/marker?position=120,30'};
    await assert.rejects(h.sendCompanionLocation('group:456',{...place,lat:91}),/有效名称或坐标/);
    const pending=h.sendCompanionLocation('group:456',place);
    h.cfg.allow.groups=[];
    await assert.rejects(pending,/未确认送达/);assert.equal(h.calls.sent.length,0);
  } finally {await h.close();}
});

test('source-specific public commands keep provider, source group and QQ card transport',async()=>{
  const requested=[];
  const h=await fixture({searchPlacesImpl:async options=>{requested.push(options);return {source:'天地图',provider:'tianditu',queriedAt:Date.now(),note:'来源已标注',places:[{id:'tianditu_abc',name:'广州塔',address:'海珠区',lat:23.1,lon:113.3,provider:'tianditu',source:'天地图'}]};},resolvePlaceImpl:async(q,city,options)=>{requested.push(options);return {id:'tencent_abc',name:'广州塔',address:'海珠区',lat:23.1,lon:113.3,provider:'tencent',source:'腾讯地图'};}});
  try {
    const reply=await h.command('[找店][广州][广州塔][来源:天地图]',{kind:'group',user:FRIEND});
    assert.equal(requested[0].provider,'tianditu');assert.match(reply,/天地图/);assert.doesNotMatch(reply,/https?:/);
    await h.command('[发定位][tianditu_abc]',{kind:'group',user:FRIEND});
    assert.ok(h.calls.sent.some(m=>m.kind==='group'&&m.segments[0].type==='json'));
    const location=await h.command('[位置][广州塔][广州][来源:腾讯地图]',{kind:'group',user:FRIEND});
    assert.equal(requested.at(-1).provider,'tencent');assert.match(location,/腾讯地图/);assert.doesNotMatch(location,/https?:/);
    assert.ok(h.calls.sent.some(m=>m.kind==='group'&&m.segments[0].type==='json'));
  }finally{await h.close();}
});

// Real follow-up failure: “发个腾讯地图的” was rejected, then the model
// queried an older request and stopped at text despite usable fallback places.
async function locationApi(h, key = 'private:123') {
  const st = h.getSocialV2State(key), server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening', r));
  return { close: () => new Promise(r => server.close(r)), call: async body => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/life`, {
      method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ key, nearby: false, query: '韶关学院', city: '韶关', ...body })
    });
    return { status: r.status, data: await r.json() };
  } };
}
function addRequest(h, key, text, user = OWNER) {
  h.appendSocialV2Message(key, '用户', text, text, false, false, String(seq++), [], user);
}
const fallbackPlaces = () => ({ provider: 'gaode', source: '高德地图', fallback: '腾讯地图日额度耗尽，已改用高德地图',
  places: [{ id: 'poi_fallback', name: '韶关学院', address: '大学路', lat: 24.77, lon: 113.66, provider: 'gaode', source: '高德地图' }] });
test('explicit map follow-up delivers fallback card once including concurrent query and send retries', async () => {
  for (const key of ['private:123', 'group:456']) {
    const h = await fixture({ searchPlacesImpl: async () => { await new Promise(r => setTimeout(r, 15)); return fallbackPlaces(); } });
    const api = await locationApi(h, key);
    try {
      addRequest(h, key, '发韶关学院位置卡片，百度地图');
      addRequest(h, key, '发个腾讯地图的');
      const body = { action: 'places', provider: 'tencent', requestText: '发个腾讯地图的' };
      const results = await Promise.all([api.call(body), api.call(body)]);
      for (const r of results) {
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.source, '高德地图');
        assert.match(r.data.fallback, /日额度耗尽/);
        assert.equal(r.data.delivery.status, 'submitted');
        assert.deepEqual(r.data.delivery.placeIds, ['poi_fallback']);
      }
      assert.equal(h.calls.sent.filter(m => m.segments[0]?.type === 'json').length, 1);
      const again = await api.call({ action: 'send-location', placeId: 'poi_fallback', requestText: body.requestText });
      assert.equal(again.status, 200, JSON.stringify(again.data));
      assert.equal(h.calls.sent.filter(m => m.segments[0]?.type === 'json').length, 1);
      // An actual new inbound request may ask for the same fallback card again.
      addRequest(h, key, body.requestText);
      assert.equal((await api.call(body)).data.delivery.status, 'submitted');
      assert.equal(h.calls.sent.filter(m => m.segments[0]?.type === 'json').length, 2);
      assert.equal((await api.call({ ...body, requestText: '发韶关学院位置卡片，百度地图' })).status, 403);
    } finally { await api.close(); await h.close(); }
  }
});
test('read-only map queries and negative requests do not send cards or authorize a substring', async () => {
  const h = await fixture({ searchPlacesImpl: async () => fallbackPlaces() }), api = await locationApi(h);
  try {
    for (const text of ['腾讯地图查一下韶关学院', '不要发位置卡片，只查询韶关学院', '请问怎么发地图卡片']) {
      addRequest(h, 'private:123', text);
      assert.equal((await api.call({ action: 'places', requestText: text })).status, 200);
    }
    addRequest(h, 'private:123', '不要发位置卡片，只查询韶关学院');
    assert.equal((await api.call({ action: 'places', requestText: '发位置卡片' })).status, 200);
    assert.equal(h.calls.sent.length, 0);
  } finally { await api.close(); await h.close(); }
});
test('automatic card closure respects disabled send, revoked policy, failed receipt and actor isolation', async () => {
  let release, entered;
  const wait = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const h = await fixture({ searchPlacesImpl: async () => { entered(); await gate; return fallbackPlaces(); } }), api = await locationApi(h, 'group:456');
  try {
    addRequest(h, 'group:456', '发个腾讯地图的', FRIEND);
    const pending = api.call({ action: 'places', provider: 'tencent', requestText: '发个腾讯地图的' });
    await Promise.race([wait, new Promise((_, reject) => setTimeout(() => reject(Error('query never reached service')), 1000))]);
    h.cfg.socialV2.tools.sendMessage = false; release();
    const blocked = await pending;
    assert.equal(blocked.data.delivery.status, 'blocked'); assert.equal(blocked.data.ok, false);
    assert.equal(h.calls.sent.length, 0);
    h.cfg.socialV2.tools.sendMessage = true;
    addRequest(h, 'group:456', '发位置卡片', OWNER);
    const foreign = await api.call({ action: 'send-location', placeId: 'poi_fallback', requestText: '发位置卡片' });
    assert.equal(foreign.data.ok, false); assert.match(foreign.data.error, /地点ID不在/);
    addRequest(h, 'group:456', '发个腾讯地图的', FRIEND);
    h.calls.locationSendFailure = true;
    const failed = await api.call({ action: 'places', requestText: '发个腾讯地图的' });
    assert.equal(failed.data.ok, false); assert.equal(failed.data.delivery.status, 'failed');
    assert.match(failed.data.delivery.error, /未确认送达/);
    const attempts = h.calls.http.filter(v => v.url.endsWith('/send_group_msg')).length;
    await api.call({ action: 'send-location', placeId: 'poi_fallback', requestText: '发个腾讯地图的' });
    assert.equal(h.calls.http.filter(v => v.url.endsWith('/send_group_msg')).length, attempts);
    assert.equal(h.calls.sent.length, 0);
  } finally { release(); await api.close(); await h.close(); }
});

test('real service adapter quota fallback reaches QQ card transport without model follow-up', async () => {
  const upstream = [];
  const life = createLifeServices({ env: { TENGXUNDITU_API_KEY: 'fixture-tencent', GAODE_WEB_API_KEY: 'fixture-gaode' }, fetchImpl: async url => {
    upstream.push(url.hostname);
    if (url.hostname === 'apis.map.qq.com') return Response.json({ status: 121, message: 'do not expose upstream body' });
    assert.equal(url.hostname, 'restapi.amap.com');
    return Response.json({ status: '1', pois: [{ id: 'fallback_campus', name: '韶关学院', location: '113.66,24.77' }] });
  } });
  const h = await fixture({ searchPlacesImpl: options => life.searchPlaces(options) }), api = await locationApi(h);
  try {
    addRequest(h, 'private:123', '发个腾讯地图的');
    const r = await api.call({ action: 'places', provider: 'tencent', requestText: '发个腾讯地图的' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.delivery.status, 'submitted');
    assert.equal(r.data.source, '高德地图'); assert.match(r.data.fallback, /腾讯地图日额度耗尽/);
    assert.equal(r.data.fallbackReasons[0].code, 'QUOTA');
    assert.deepEqual(upstream, ['apis.map.qq.com', 'restapi.amap.com']);
    const card = JSON.parse(h.calls.sent[0].segments[0].data.data);
    assert.equal(card.meta['Location.Search'].name, '韶关学院');
    assert.equal(h.calls.sent.length, 1);
  } finally { await api.close(); await h.close(); }
});
test('map delivery stops for changed requests, pause, quota and all-provider failure', async () => {
  for (const scenario of ['cancel', 'pause', 'quota', 'unavailable']) {
    let entered, release;
    const wait = new Promise(r => entered = r), gate = new Promise(r => release = r);
    const h = await fixture({ searchPlacesImpl: async () => {
      entered(); await gate;
      if (scenario === 'unavailable') throw Error('地图服务均未返回可用地点');
      return fallbackPlaces();
    } }), api = await locationApi(h);
    try {
      addRequest(h, 'private:123', '发个腾讯地图的');
      const pending = api.call({ action: 'places', requestText: '发个腾讯地图的' });
      await Promise.race([wait, new Promise((_, reject) => setTimeout(() => reject(Error('service not reached')), 1000))]);
      if (scenario === 'cancel') addRequest(h, 'private:123', '不用发了');
      if (scenario === 'pause') h.socialV2.paused = true;
      if (scenario === 'quota') h.cfg.sendLimits.private = { perMinute: 1, perHour: 1, perDay: 1 }, h.getSocialV2State('private:123').sendTimes = [Date.now()];
      release();
      const r = await pending;
      assert.equal(r.data.ok, false, scenario + JSON.stringify(r.data));
      assert.equal(h.calls.sent.length, 0, scenario);
    } finally { release(); await api.close(); await h.close(); }
  }
});
test('partial candidate delivery reports submitted count and never replays accepted cards', async () => {
  const h = await fixture({ searchPlacesImpl: async () => {
    const data = fallbackPlaces(); data.places.push({ ...data.places[0], id: 'second_campus', name: '第二校区' }); return data;
  } }), api = await locationApi(h);
  try {
    h.cfg.sendLimits.private = { perMinute: 1, perHour: 1, perDay: 1 };
    addRequest(h, 'private:123', '发个腾讯地图的');
    const body = { action: 'places', requestText: '发个腾讯地图的' };
    const result = await api.call(body);
    assert.equal(result.data.ok, false); assert.match(result.data.error, /已有1张/);
    assert.deepEqual(result.data.delivery.placeIds, ['poi_fallback']); assert.equal(h.calls.sent.length, 1);
    await api.call(body); assert.equal(h.calls.sent.length, 1);
  } finally { await api.close(); await h.close(); }
});
