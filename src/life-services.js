// 天气与地点：固定官方HTTPS端点、有限请求/缓存；不向调用者返回密钥或请求URL。
import {wgs84ToGcj02,gcj02ToWgs84,straightDistance} from './geo-coordinates.js';
const MAP_SOURCES={gaode:'高德地图',tencent:'腾讯地图',tianditu:'天地图',baidu:'百度地图'};
export function normalizeMapProvider(value='auto') {
  const aliases={'自动':'auto','高德':'gaode','高德地图':'gaode','腾讯':'tencent','腾讯地图':'tencent','天地图':'tianditu','百度':'baidu','百度地图':'baidu'};
  const name=aliases[value]||String(value||'auto');
  if(!['auto',...Object.keys(MAP_SOURCES)].includes(name))throw new LifeServiceError('地点来源须为自动、高德、腾讯地图、天地图或百度地图。','QUERY');
  return name;
}
const MINUTE = 60000;
const text = (v, max = 100) => String(v ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max);
const num = (v) => v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : null;
export const bjDate = (at = Date.now()) => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
export const bjClock = (at = Date.now()) => new Date(at + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

export class LifeServiceError extends Error {
  constructor(message, code = 'UNAVAILABLE', details = {}) { super(message); this.code = code; if (Array.isArray(details.candidates)) this.candidates = details.candidates; }
}
export function coordinates(value) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(value ?? ''));
  if (!m || Math.abs(Number(m[1])) > 180 || Math.abs(Number(m[2])) > 90) return null;
  return { lon: Number(m[1]), lat: Number(m[2]) };
}
export function mapLink(place) {
  if(place.provider==='baidu') {
    const u=new URL('https://api.map.baidu.com/marker');u.search=new URLSearchParams({location:`${place.lat},${place.lon}`,title:text(place.name),content:text(place.address),coord_type:'gcj02',output:'html',src:'qq-bridge'}).toString();return u.href;
  }
  if(place.provider==='tencent') {
    const u=new URL('https://apis.map.qq.com/uri/v1/marker');
    u.search=new URLSearchParams({marker:`coord:${place.lat},${place.lon};title:${text(place.name)};addr:${text(place.address)}`,referer:'qq-bridge'}).toString();return u.href;
  }
  if(place.provider==='tianditu')return 'https://map.tianditu.gov.cn/';
  const u = new URL('https://uri.amap.com/marker');
  u.search = new URLSearchParams({ position: `${place.lon},${place.lat}`, name: text(place.name), coordinate: 'gaode', callnative: '0' }).toString();
  return u.href;
}
function administrativeName(value) {
  return String(value || '').replace(/(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|省|市|区|县)/g, '');
}
function uniqueLocation(items, query, administrative = false) {
  if (!items.length) throw new LifeServiceError('没有找到这个地点，请补充城市和区县。', 'NOT_FOUND');
  const exact = items.filter((p) => [p.name, p.fullName].includes(query));
  if (items.length === 1) return items[0];
  if (exact.length === 1) return exact[0];
  if (administrative) {
    // GeoAPI会把“杭州市西湖区”模糊搜成“浙江省/杭州/西湖”等多组候选。
    // 保留上级行政区约束，仅忽略行政后缀；只在唯一匹配时选中。
    const normalized = administrativeName(query);
    const qualified = items.filter((p) => {
      const full = p.adminParts ? [...new Set(p.adminParts.map(administrativeName).filter(Boolean))].join('') : administrativeName(p.fullName);
      return normalized.length >= 2 && full.endsWith(normalized);
    });
    if (qualified.length === 1) return qualified[0];
  }
  const candidates = items.slice(0, 4).map((p) => p.fullName || p.name);
  throw new LifeServiceError(`地点有多个匹配，请补充城市/区县：${candidates.join('；')}`, 'AMBIGUOUS', { candidates });
}

export function createLifeServices({ env = process.env, fetchImpl = fetch, now = Date.now, config = {} } = {}) {
  const cache = new Map(), pending = new Map(), mapCooldowns=new Map();
  let active = 0;
  const host = text(env.HEFENG_WEATHER_API_HOST || env.QWEATHER_API_HOST || config.hefengHost, 180).replace(/^https:\/\//, '').replace(/\/$/, '');
  const hefengKey = env.HEFENG_WEATHER_API_KEY || '';
  const gaodeKey = env.GAODE_WEB_API_KEY || '';
  const tencentKey=env.TENGXUNDITU_API_KEY||'',tiandituKey=env.TIANDITU_API_KEY||'';
  const baiduKey=env.BAIDUDITU_API_KEY||'';
  const mapKeys={gaode:gaodeKey,tencent:tencentKey,tianditu:tiandituKey,baidu:baiduKey};
  const validHost = /^(?:[a-z0-9-]+\.)+qweatherapi\.com$/i.test(host);
  const status = () => ({ hefengKey: !!hefengKey, hefengHost: validHost, gaodeKey: !!gaodeKey, tencentKey:!!tencentKey,tiandituKey:!!tiandituKey,baiduKey:!!baiduKey,mapCooldowns:Object.fromEntries([...mapCooldowns].filter(([,v])=>v.until>now())) });
  async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && hit.until > now()) return structuredClone(hit.value);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    if (pending.size >= 12) throw new LifeServiceError('天气/地点查询繁忙，请稍后再试。', 'BUSY');
    const promise = (async () => {
      const value = await fn();
      cache.delete(key); cache.set(key, { until: now() + ttl, value });
      while (cache.size > 128) cache.delete(cache.keys().next().value);
      return value;
    })();
    pending.set(key, promise);
    try { return structuredClone(await promise); } finally { pending.delete(key); }
  }
  async function get(provider, pathname, params = {}) {
    if (active >= 6) throw new LifeServiceError('查询繁忙，请稍后再试。', 'BUSY');
    if (provider === 'hefeng' && (!hefengKey || !validHost)) throw new LifeServiceError('和风凭据或专属API Host未配置。', 'CONFIG');
    if (provider === 'gaode' && !gaodeKey) throw new LifeServiceError('高德Key未配置。', 'CONFIG');
    if(provider!=='hefeng'&&!mapKeys[provider])throw new LifeServiceError('所选地图凭据未配置。','CONFIG');
    const origin={hefeng:`https://${host}`,gaode:'https://restapi.amap.com',tencent:'https://apis.map.qq.com',tianditu:'https://api.tianditu.gov.cn',baidu:'https://api.map.baidu.com'}[provider];
    if(!origin)throw new LifeServiceError('不支持的服务来源。','QUERY');
    const label=provider==='hefeng'?'和风':MAP_SOURCES[provider];
    const url = new URL(pathname,origin);
    url.search = new URLSearchParams({ ...params, ...(provider === 'gaode' ? { key: gaodeKey, output: 'JSON' } : provider==='tencent'?{key:tencentKey,output:'json'}:provider==='tianditu'?{tk:tiandituKey}:provider==='baidu'?{ak:baiduKey,output:'json'}:{}) }).toString();
    active++;
    try {
      const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: provider === 'hefeng' ? { 'X-QW-Api-Key': hefengKey } : {} });
      if (!res.ok) throw new LifeServiceError(provider==='tianditu'&&res.status===403?'天地图权限校验未通过（HTTP403），请检查服务端Key及地名搜索权限。':`${label}接口HTTP ${res.status}`,res.status===401||res.status===403?'PERMISSION':'HTTP');
      let raw = ''; const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        raw += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        if (raw.length > 300000) throw new LifeServiceError('接口返回过大。', 'INVALID');
      }
      raw += decoder.decode();
      const data = JSON.parse(raw);
      const tdtCode=data.status?.infocode??data.status?.[0]?.infocode;
      if(provider==='tencent'&&data.status===121||provider==='gaode'&&String(data.infocode)==='10003'||provider==='baidu'&&[4,302].includes(data.status))throw new LifeServiceError(`${label}当日调用额度已用尽。`,'QUOTA');
      if(provider==='baidu'&&[3,5,9,101,200,201,202,203,210,211,240].includes(data.status))throw new LifeServiceError('百度地图权限校验未通过，请检查服务端Key和地点检索权限。','PERMISSION');
      if ((provider === 'gaode' && String(data.status) !== '1') || (provider === 'hefeng' && data.code && String(data.code) !== '200') || (provider==='tencent'&&data.status!==0) || (provider==='baidu'&&data.status!==0) || (provider==='tianditu'&&String(tdtCode)!=='1000'&&String(tdtCode)!=='3001') || data.error) {
        throw new LifeServiceError(`${label}接口未成功（${text(provider==='tencent'||provider==='baidu'?data.status:provider==='tianditu'?tdtCode:data.infocode||data.code||res.status,12).replace(/[^\d]/g,'')}），请检查额度和凭据权限。`, 'API');
      }
      return data;
    } catch (e) {
      if (e instanceof LifeServiceError) throw e;
      throw new LifeServiceError(`${label}请求超时、网络异常或返回无效。`, 'NETWORK');
    } finally { active--; }
  }
  async function hefengCity(query) {
    return cached(`hgeo:${query}`, 1440 * MINUTE, async () => {
      const data = await get('hefeng', '/geo/v2/city/lookup', { location: query, number: '5', lang: 'zh' });
      const items = (data.location || []).map((p) => ({ name: text(p.name), fullName: [...new Set([p.adm1, p.adm2, p.name].filter(Boolean))].join(''), adminParts: [p.adm1, p.adm2, p.name], lon: num(p.lon), lat: num(p.lat) })).filter((p) => p.lon != null && p.lat != null);
      return uniqueLocation(items, query, true);
    });
  }
  async function gaodeCity(query) {
    return cached(`ggeo:${query}`, 1440 * MINUTE, async () => {
      const data = await get('gaode', '/v3/geocode/geo', { address: query });
      const items = (data.geocodes || []).map((p) => ({ name: text(Array.isArray(p.district) ? p.city : p.district || p.city), fullName: text(p.formatted_address), adcode: text(p.adcode), ...coordinates(p.location) })).filter((p) => p.lat != null && /^\d{6}$/.test(p.adcode));
      return uniqueLocation(items, query, true);
    });
  }
  async function weather(city) {
    const query = text(city, 80);
    if (!query) throw new LifeServiceError('请先告诉我城市/区县，或用[天气城市][城市区县]设置。', 'LOCATION');
    return cached(`weather:${query}`, 10 * MINUTE, async () => {
      let primaryReason = '';
      try {
        const place = await hefengCity(query);
        const suffix = `${place.lat.toFixed(2)}/${place.lon.toFixed(2)}`;
        const [current, daily] = await Promise.all([
          get('hefeng', `/weather/v1/current/${suffix}`, { lang: 'zh' }),
          get('hefeng', `/weather/v1/daily/${suffix}`, { days: '3', lang: 'zh', localTime: 'true' })
        ]);
        const days = (daily.days || []).map((p) => ({ date: bjDate(Date.parse(p.forecastStartTime)), min: num(p.temperatureMin?.value), max: num(p.temperatureMax?.value), day: text(p.daytime?.condition?.text), night: text(p.nighttime?.condition?.text) }));
        if (num(current.temperature?.value) == null || !days.length || days.some((p) => p.min == null || p.max == null)) throw new LifeServiceError('和风返回的天气字段不完整。', 'INVALID');
        let hours = [];
        try {
          const hourly = await get('hefeng', `/weather/v1/hourly/${suffix}`, { hours: '24', lang: 'zh', localTime: 'true' });
          hours = (hourly.hours || []).map((p) => ({ at: Date.parse(p.forecastTime), text: text(p.condition?.text), probability: num(p.precipitation?.probability) })).filter((p) => Number.isFinite(p.at));
        } catch { /* 日预报可用时，逐小时失败只降级这一项能力。 */ }
        return { provider: 'hefeng', source: '和风天气', city: place.fullName || place.name, queriedAt: now(), updatedAt: null,
          current: { text: text(current.condition?.text), temp: num(current.temperature?.value) }, days, hours,
          attribution: 'https://developer.qweather.com/attribution.html', limitations: hours.length ? [] : ['逐小时预报暂不可用，不提供精确降雨时刻。'] };
      } catch (e) {
        if (e.code === 'AMBIGUOUS') throw e;
        primaryReason = e.code === 'CONFIG' ? '和风凭据或专属Host未配置' : '和风暂不可用';
      }
      try {
        const place = await gaodeCity(query);
        const [current, daily] = await Promise.all([
          get('gaode', '/v3/weather/weatherInfo', { city: place.adcode, extensions: 'base' }),
          get('gaode', '/v3/weather/weatherInfo', { city: place.adcode, extensions: 'all' })
        ]);
        const live = current.lives?.[0], forecast = daily.forecasts?.[0];
        if (!live || !forecast || num(live.temperature) == null || !forecast.casts?.length) throw new LifeServiceError('高德天气数据不完整。', 'INVALID');
        const days = forecast.casts.map((p) => ({ date: text(p.date, 10), min: num(p.nighttemp), max: num(p.daytemp), day: text(p.dayweather), night: text(p.nightweather) }));
        if (days.some((p) => p.min == null || p.max == null)) throw new LifeServiceError('高德预报字段不完整。', 'INVALID');
        return { provider: 'gaode', source: '高德天气', city: place.fullName || place.name, queriedAt: now(), updatedAt: text(live.reporttime, 25),
          forecastUpdatedAt: text(forecast.reporttime, 25), current: { text: text(live.weather), temp: num(live.temperature) }, days, hours: [],
          attribution: 'https://www.amap.com', fallback: primaryReason, limitations: ['高德兜底只有日预报，不提供逐小时降雨时刻。'] };
      } catch (e) {
        if (e.code === 'AMBIGUOUS') throw e;
        throw new LifeServiceError(`${primaryReason}，高德兜底也未成功；现在没有查到可靠天气，请稍后再试。`, 'UNAVAILABLE');
      }
    });
  }
  async function searchPlaces({ query, city = '', center = '', radius = 2000,provider='auto',fallback=true } = {}) {
    query = text(query, 60); city = text(city, 60); center = text(center, 100);
    if (!query) throw new LifeServiceError('请说明要找的店铺或类别。', 'QUERY');
    radius = Math.min(10000, Math.max(100, Number(radius) || 2000));
    provider=normalizeMapProvider(provider);
    return cached(`poi:${provider}:${fallback}:${query}:${city}:${center}:${radius}`, 5 * MINUTE, async () => {
      const failed=[],failureReasons={};let locationError;
      const order=provider==='auto'?Object.keys(MAP_SOURCES):[provider,...(fallback?Object.keys(MAP_SOURCES).filter(v=>v!==provider):[])];
      for(const name of order)try {
        if(!mapKeys[name]||(mapCooldowns.get(name)?.until||0)>now()){failed.push(name);failureReasons[name]=!mapKeys[name]?'CONFIG':mapCooldowns.get(name).reason;continue;}
        let point;
        if(center)point=coordinates(center)||await resolvePlace(center,city,{provider:name,fallback:false});
        let places;
        if(name==='gaode') {
          const data = await get('gaode', point ? '/v3/place/around' : '/v3/place/text', {
        keywords: query, offset: '5', page: '1', extensions: 'base',
        ...(point ? { location: `${point.lon},${point.lat}`, radius: String(radius), sortrule: 'distance' } : {}),
        ...(city ? { city, citylimit: 'true' } : {})
      });
          places=(data.pois||[]).map(p=>({id:text(p.id,60),name:text(p.name),address:text([p.pname,p.cityname,p.adname,typeof p.address==='string'?p.address:''].filter(Boolean).join(''),180),...coordinates(p.location),distance:num(p.distance)}));
        }else if(name==='tencent') {
          if(!point&&!city)throw new LifeServiceError('腾讯地图全城查询请补充城市，或明确附近中心。','LOCATION');
          if(/[(),]/.test(city))throw new LifeServiceError('城市名称格式无效。','QUERY');
          const data=await get(name,'/ws/place/v1/search/',{keyword:query,page_size:'5',page_index:'1',boundary:point?`nearby(${point.lat},${point.lon},${radius},0)`:`region(${city},0)`});
          places=(data.data||[]).map(p=>({id:'tencent_'+text(p.id,45),name:text(p.title),address:text(p.address,180),...coordinates(`${p.location?.lng},${p.location?.lat}`),distance:num(p._distance)}));
        }else if(name==='baidu') {
          const data=await get(name,'/place/v2/search',{query,page_size:'5',page_num:'0',scope:'1',coord_type:'2',ret_coordtype:'gcj02ll',...(point?{location:`${point.lat},${point.lon}`,radius:String(radius),radius_limit:'true'}:{region:city||'全国',city_limit:city?'true':'false'})});
          places=(data.results||[]).map(p=>({id:'baidu_'+text(p.uid,48),name:text(p.name),address:text(p.address,180),...coordinates(`${p.location?.lng},${p.location?.lat}`),distance:null}));
        }else {
          const centerRaw=point?gcj02ToWgs84(point):null;
          const postStr={keyWord:query,level:12,start:0,count:5,...(centerRaw?{queryType:3,pointLonlat:`${centerRaw.lon},${centerRaw.lat}`,queryRadius:radius}:{queryType:city?12:1,...(city?{specify:city}:{mapBound:'-180,-90,180,90'})})};
          const data=await get(name,'/v2/search',{type:'query',postStr:JSON.stringify(postStr)});
          places=(data.pois||[]).map(p=>{const raw=coordinates(p.lonlat);return {id:'tianditu_'+text(p.hotPointID,44),name:text(p.name),address:text(p.address,180),...(raw?wgs84ToGcj02(raw):{}),distance:null};});
        }
        places=places.filter(p=>p.name&&p.lon!=null&&p.lat!=null&&p.id&&!p.id.endsWith('_')).slice(0,5);
        for(const p of places){p.provider=name;p.source=MAP_SOURCES[name];p.coordinateSystem='gcj02';p.url=mapLink(p);if(point&&p.distance==null)p.distance=straightDistance(point,p);}
        if(!places.length){failed.push(name);failureReasons[name]='NOT_FOUND';continue;}
        return {provider:name,source:MAP_SOURCES[name],queriedAt:now(),center:point?{name:text(point.fullName||point.name||center),lon:point.lon,lat:point.lat}:null,radius:point?radius:null,places,
          ...(failed.length?{fallback:failed.map(v=>MAP_SOURCES[v]+({QUOTA:'日额度耗尽',PERMISSION:'权限校验未通过',CONFIG:'凭据未配置',NOT_FOUND:'无匹配地点'}[failureReasons[v]]||'暂不可用')).join('、')+'，已改用'+MAP_SOURCES[name],
            fallbackReasons:failed.map(v=>({provider:v,source:MAP_SOURCES[v],code:failureReasons[v]||'UNAVAILABLE'}))}:{}),note:'地点信息与直线距离供参考；营业状态、评分及步行距离未核实。'+(name==='tianditu'?'天地图地理坐标已转换为QQ卡片坐标，非测绘级精度。':'')};
      }catch(e){
        if(!fallback||['AMBIGUOUS','QUERY','BUSY'].includes(e.code))throw e;
        if(e.code==='LOCATION')locationError=e;
        if(['QUOTA','PERMISSION','HTTP','NETWORK','API'].includes(e.code))mapCooldowns.set(name,{until:e.code==='QUOTA'?Date.parse(bjDate(now()+86400000)+'T00:00:00+08:00'):now()+(e.code==='PERMISSION'?3600000:30000),reason:e.code});
        failed.push(name);
        failureReasons[name]=['QUOTA','PERMISSION','HTTP','NETWORK','API','LOCATION','CONFIG','NOT_FOUND'].includes(e.code)?e.code:'UNAVAILABLE';
      }
      if(locationError)throw locationError;
      throw new LifeServiceError('地图服务均未返回可用地点，请补充城市和具体地点或稍后重试。','UNAVAILABLE');
    });
  }
  async function resolvePlace(query, city = '',{provider='auto',fallback=true}={}) {
    const data = await searchPlaces({ query, city,provider,fallback });
    return {...uniqueLocation(data.places.map((p) => ({ ...p, fullName: `${p.address}${p.name}` })), query),...(data.fallback?{fallback:data.fallback}:{})};
  }
  return { status, weather, searchPlaces, resolvePlace, get, cached, hefengCity, gaodeCity, now };
}

export function formatWeather(data, day = '今天') {
  const date = bjDate(data.queriedAt + (day === '明天' ? 86400000 : 0));
  const row = data.days.find((p) => p.date === date);
  if (!row) throw new LifeServiceError('接口没有返回所问日期的预报。', 'DATE');
  return [`【${data.city} ${day}天气】${row.date}`,
    ...(day === '今天' ? [`当前${data.current.text} ${data.current.temp}℃`] : []),
    `白天${row.day}，夜间${row.night}；${row.min}~${row.max}℃`,
    `来源：${data.source}${data.fallback ? `（${data.fallback}，已兜底）` : ''}`,
    ...(data.updatedAt ? [`实况发布时间：${data.updatedAt}；预报发布时间：${data.forecastUpdatedAt}`] : []),
    `查询时间：${bjClock(data.queriedAt)}`,
    ...data.limitations, `数据归因：${data.attribution}`].join('\n');
}
export function weatherConcern(data, { now = data.queriedAt, departureHours = [8, 18], cooling = 5 } = {}) {
  const today = data.days.find((p) => p.date === bjDate(now)), tomorrow = data.days.find((p) => p.date === bjDate(now + 86400000));
  const facts = [];
  if (today && tomorrow && today.max - tomorrow.max >= cooling) facts.push(`明天最高温${tomorrow.max}℃，比今天低${Math.round((today.max - tomorrow.max) * 10) / 10}℃`);
  const rain = data.hours.find((p) => p.at >= now && p.at < now + 86400000 && departureHours.some((h) => Math.abs(Number(bjClock(p.at).slice(-5, -3)) - h) <= 1)
    && (/[雨雪雷]/.test(p.text) || p.probability >= 0.6));
  if (rain) facts.push(`${bjClock(rain.at)}出门时段预报${rain.text}，可以提醒带伞`);
  else if (!data.hours.length && tomorrow && /[雨雪雷]/.test(tomorrow.day + tomorrow.night)) facts.push(`明天日预报有雨雪，具体时段未提供`);
  return facts.length ? `${data.city}：${facts.join('；')}。来源${data.source}，查询于${bjClock(data.queriedAt)}。${data.fallback ? '当前使用高德兜底。' : ''}` : '';
}
