import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifeServices, coordinates, mapLink, formatWeather, weatherConcern } from '../src/life-services.js';
test('coordinates validates ranges and map links carry no API key', () => {
  assert.equal(coordinates('181,10'), null);
  assert.deepEqual(coordinates('120.2,30.3'), { lon: 120.2, lat: 30.3 });
  assert.match(mapLink({ lon: 120, lat: 30, name: '店铺' }), /uri\.amap\.com/);
  assert.doesNotMatch(mapLink({ lon: 120, lat: 30 }), /key=/);
});
const now = Date.parse('2026-10-22T07:30:00+08:00');
const gaodeResponse = (url) => url.pathname.includes('geocode')
  ? { status: '1', geocodes: [{ district: '西湖区', formatted_address: '杭州市西湖区', adcode: '330106', location: '120.13,30.26' }] }
  : { status: '1', lives: [{ temperature: '21', weather: '晴', reporttime: '2026-10-22 07:00:00' }], forecasts: [{ reporttime: '2026-10-22 07:00:00', casts: [
    { date: '2026-10-22', daytemp: '25', nighttemp: '18', dayweather: '晴', nightweather: '晴' },
    { date: '2026-10-23', daytemp: '18', nighttemp: '15', dayweather: '小雨', nightweather: '小雨' }
  ] }] };
test('missing Hefeng host falls back to Gaode with explicit source, date and capability limits', async () => {
  const s = createLifeServices({ now: () => now, env: { GAODE_WEB_API_KEY: 'secret' }, fetchImpl: async (url) => Response.json(gaodeResponse(url)) });
  const d = await s.weather('杭州西湖区');
  assert.equal(d.provider, 'gaode'); assert.match(formatWeather(d, '明天'), /2026-10-23/);
  assert.match(formatWeather(d), /只有日预报/); assert.match(weatherConcern(d), /低7℃/);
  assert.doesNotMatch(JSON.stringify(d), /secret/);
});
test('Hefeng v1 wins, secondary never called; hourly failure preserves valid primary daily forecast', async () => {
  const called = [];
  const s = createLifeServices({ now: () => now, env: { HEFENG_WEATHER_API_KEY: 'secret', HEFENG_WEATHER_API_HOST: 'a.qweatherapi.com', GAODE_WEB_API_KEY: 'g' }, fetchImpl: async (url, opts) => {
    called.push(url.hostname); assert.equal(opts.headers['X-QW-Api-Key'], 'secret');
    if (url.pathname.includes('lookup')) return Response.json({ code: '200', location: [{ name: '西湖区', adm2: '杭州市', lat: '30.26', lon: '120.13' }] });
    if (url.pathname.includes('current')) return Response.json({ condition: { text: '晴' }, temperature: { value: 21 } });
    if (url.pathname.includes('hourly')) return new Response('', { status: 503 });
    return Response.json({ days: [{ forecastStartTime: '2026-10-22T00:00:00+08:00', temperatureMin: { value: 18 }, temperatureMax: { value: 25 }, daytime: { condition: { text: '晴' } }, nighttime: { condition: { text: '晴' } } }] });
  } });
  const d = await s.weather('西湖区'); assert.equal(d.provider, 'hefeng');
  assert.ok(called.every((h) => h === 'a.qweatherapi.com')); assert.equal(d.hours.length, 0);
  assert.match(formatWeather(d), /查询时间/);
});
test('invalid primary payload falls back, total failure reports honest unavailable', async () => {
  const s = createLifeServices({ now: () => now, env: { HEFENG_WEATHER_API_KEY: 's', HEFENG_WEATHER_API_HOST: 'a.qweatherapi.com', GAODE_WEB_API_KEY: 'g' }, fetchImpl: async (url) => Response.json(url.hostname.includes('qweather') ? {} : gaodeResponse(url)) });
  assert.equal((await s.weather('杭州')).provider, 'gaode');
  await assert.rejects(createLifeServices({ env: {} }).weather('杭州'), /没有查到可靠天气/);
});
test('nearby search uses validated center and bounded radius; no guessed location', async () => {
  let last;
  const s = createLifeServices({ env: { GAODE_WEB_API_KEY: 's' }, fetchImpl: async (url) => { last = url; return Response.json({ status: '1', pois: [{ id: 'abc', name: '咖啡店', location: '120.13,30.26', address: '一号路', distance: '100' }] }); } });
  const d = await s.searchPlaces({ query: '咖啡', center: '120.1,30.2', radius: 99999 });
  assert.equal(last.pathname, '/v3/place/around'); assert.equal(last.searchParams.get('radius'), '10000');
  assert.equal(d.places[0].distance, 100); assert.match(d.places[0].url, /coordinate=gaode/);
});
test('transport never exposes credentials/network error details and rejects unsafe hosts', async () => {
  const s = createLifeServices({ env: { HEFENG_WEATHER_API_KEY: 'secret', HEFENG_WEATHER_API_HOST: 'localhost' } });
  await assert.rejects(s.get('hefeng', '/geo/v2/city/lookup'), /Host未配置/);
  const n = createLifeServices({ env: { GAODE_WEB_API_KEY: 'secret' }, fetchImpl: async () => { throw Error('url?key=secret'); } });
  await assert.rejects(n.gaodeCity('杭州'), (e) => !e.message.includes('secret') && e.code === 'NETWORK');
});
test('duplicate geocoding shares an inflight request and ambiguous locations require clarification', async () => {
  let calls = 0;
  const s = createLifeServices({ env: { GAODE_WEB_API_KEY: 'secret' }, fetchImpl: async () => {
    calls++; await new Promise((r) => setTimeout(r, 5));
    return Response.json({ status: '1', geocodes: [{ district: '西湖区', formatted_address: '浙江省杭州市西湖区', adcode: '330106', location: '120.13,30.26' }] });
  } });
  const [a, b] = await Promise.all([s.gaodeCity('杭州西湖区'), s.gaodeCity('杭州西湖区')]);
  assert.equal(calls, 1); a.name = '改'; assert.notEqual(a.name, b.name);
  const m = createLifeServices({ env: { GAODE_WEB_API_KEY: 's' }, fetchImpl: async () => Response.json({ status: '1', geocodes: [
    { district: '朝阳区', formatted_address: '北京朝阳区', adcode: '110105', location: '116,39' },
    { district: '朝阳区', formatted_address: '长春朝阳区', adcode: '220104', location: '125,43' }
  ] }) });
  await assert.rejects(m.gaodeCity('朝阳区'), (e) => e.code === 'AMBIGUOUS' && e.candidates.includes('北京朝阳区') && e.candidates.includes('长春朝阳区'));
});
test('qualified city/district names match GeoAPI suffix-free names without picking another province', async () => {
  const locations = [
    { name: '杭州', adm1: '浙江省', adm2: '杭州', lat: '30.29', lon: '120.15' },
    { name: '西湖', adm1: '浙江省', adm2: '杭州', lat: '30.26', lon: '120.13' },
    { name: '东西湖', adm1: '湖北省', adm2: '武汉', lat: '30.62', lon: '114.13' },
    { name: '西湖', adm1: '江西省', adm2: '南昌', lat: '28.65', lon: '115.88' }
  ];
  const service = (list) => createLifeServices({ env: { HEFENG_WEATHER_API_HOST: 'a.qweatherapi.com', HEFENG_WEATHER_API_KEY: 's' }, fetchImpl: async () => Response.json({ code: '200', location: list }) });
  const s = service(locations);
  assert.equal((await s.hefengCity('杭州市西湖区')).lat, 30.26);
  assert.equal((await s.hefengCity('浙江省杭州市西湖区')).lat, 30.26);
  assert.equal((await s.hefengCity('南昌市西湖区')).lat, 28.65);
  await assert.rejects(s.hefengCity('西湖区'), (e) => e.code === 'AMBIGUOUS');
  const b = service([{ name: '东城', adm1: '北京市', adm2: '北京', lat: '39.9', lon: '116.4' }, { name: '东城', adm1: '广东省', adm2: '东莞', lat: '23', lon: '113' }]);
  assert.equal((await b.hefengCity('北京市东城区')).lat, 39.9);
});
test('Guangzhou city matches uniquely even when GeoAPI also returns its districts', async () => {
  const s = createLifeServices({ env: { HEFENG_WEATHER_API_HOST: 'a.qweatherapi.com', HEFENG_WEATHER_API_KEY: 's' }, fetchImpl: async () => Response.json({ code: '200', location: [
    { name: '广州', adm1: '广东省', adm2: '广州', lat: '23.13', lon: '113.26' },
    { name: '番禺', adm1: '广东省', adm2: '广州', lat: '22.94', lon: '113.38' },
    { name: '从化', adm1: '广东省', adm2: '广州', lat: '23.55', lon: '113.59' }
  ] }) });
  for (const q of ['广州', '广州市', '广东省广州市']) assert.equal((await s.hefengCity(q)).name, '广州');
});
