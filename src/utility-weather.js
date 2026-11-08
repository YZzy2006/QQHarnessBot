import {formatWeather} from './life-services.js';
import {WEATHER_QUERY_HELP} from './companion.js';
import {nextQueryContextOrder} from './local-request-queue.js';
const SETTING_COMMANDS=new Set(['我的城市','我的设置','查询偏好','我的安静时段']);
export function createUtilityWeather(d) {
  const contexts=new Map(),now=d.now||Date.now;
  const actor=ctx=>ctx.sourceKey+':'+ctx.userId;
  function context(ctx){const c=contexts.get(actor(ctx));if(c&&now()-c.at<300000)return c;contexts.delete(actor(ctx));return null;}
  function remember(ctx,c){contexts.delete(actor(ctx));contexts.set(actor(ctx),{...c,at:now(),order:nextQueryContextOrder()});while(contexts.size>500)contexts.delete(contexts.keys().next().value);}
  const isFollowup=input=>/^(?:(?:那|那么)?(?:今天|明天)(?:呢|的呢|天气呢)?[？?]?|(?:换成|换到|改成).{2,60}[。？?]?|(?:选|选择)(?:第)?[一二三四五1-5](?:个|项)?)$/.test(String(input).trim());
  async function handle(ctx,cmd,input) {
    let c=cmd?.command,a=cmd?.args||[],query=false;
    if(SETTING_COMMANDS.has(c)) {
      if(c==='我的设置') {const p=d.store.profile(ctx.userId);await d.say(ctx,['【我的设置】','城市：'+(p.city||'未设置'),'回复：'+p.detail,'通知安静时段：'+p.quietStart+'点~'+p.quietEnd+'点','[我的城市][广州市天河区] / [查询偏好][简洁或详细] / [我的安静时段][22-8]'].join('\n'));}
      else if(c==='我的城市') {
        if(a[0]==='清除'&&a[1]==='确认') {d.store.editProfile(ctx.userId,p=>{p.city='';});await d.say(ctx,'已清除你本人的默认城市。');}
        else {
          if(a.length!==1||!a[0]?.trim()||a[0].length>80)throw Error('写法：[我的城市][广东省广州市天河区]；清除用[我的城市][清除][确认]');
          const data=await d.life.weather(a[0]);
          d.store.editProfile(ctx.userId,p=>{p.city=a[0].trim();});
          contexts.delete(actor(ctx));await d.say(ctx,'你的天气城市已保存为'+data.city+'，只修改你本人的设置。');
        }
      } else if(c==='查询偏好') {
        if(a.length!==1||!['简洁','详细'].includes(a[0]))throw Error('写法：[查询偏好][简洁] 或 [查询偏好][详细]');
        d.store.editProfile(ctx.userId,p=>{p.detail=a[0];});await d.say(ctx,'已保存你本人的查询回复偏好：'+a[0]);
      } else {
        const m=/^(\d{1,2})-(\d{1,2})$/.exec(a[0]||'');
        if(a.length!==1||!m||Number(m[1])>23||Number(m[2])>23||Number(m[1])===Number(m[2]))throw Error('写法：[我的安静时段][22-8]，起止小时不同且为0~23');
        d.store.editProfile(ctx.userId,p=>{p.quietStart=Number(m[1]);p.quietEnd=Number(m[2]);});
        await d.say(ctx,'已保存你本人的扩展订阅通知安静时段；不改动旧免打扰设置。');
      }
      return true;
    }
    const old=context(ctx);let city,day;
    if(c==='天气'||c==='天气查询') {
      if(cmd.natural&&ctx.sourceKey.startsWith('group:')&&!ctx.directed&&!ctx.quotedId&&!old)return false;
      if(a.length>2||c==='天气查询'&&(!a[0]||['今天','明天'].includes(a[0]))) {await d.say(ctx,WEATHER_QUERY_HELP);return true;}
      city=a[0]||'';day=a[1]||'今天';
      if(['今天','明天'].includes(city)){day=city;city='';}
      query=true;
    } else if(old) {
      let m;
      if((m=/^(?:那|那么)?(今天|明天)(?:呢|的呢|天气呢)?[？?]?$/.exec(input.trim()))) {city=old.city;day=m[1];query=true;}
      else if((m=/^(?:换成|换到|改成)(.{2,60}?)[。？?]?$/.exec(input.trim()))) {city=m[1];day=old.day||'今天';query=true;}
      else if((m=/^(?:选|选择)(?:第)?([一二三四五1-5])(?:个|项)?$/.exec(input.trim()))&&old.candidates) {
        const index='一二三四五'.includes(m[1])?'一二三四五'.indexOf(m[1]):Number(m[1])-1;
        if(!old.candidates[index])throw Error('请按上次返回的候选序号选择');
        city=old.candidates[index];day=old.day;query=true;
      }
    }
    if(!query)return false;
    if(!['今天','明天'].includes(day)){await d.say(ctx,WEATHER_QUERY_HELP);return true;}
    city=String(city||d.store.profile(ctx.userId).city||(String(ctx.userId)===String(d.ownerQQ())?d.ownerCity?.():'')||'').trim();
    if(!city){await d.say(ctx,WEATHER_QUERY_HELP+'\n也可先设置本人城市：[我的城市][广东省广州市天河区]');return true;}
    contexts.delete(actor(ctx));
    try {
      const data=await d.life.weather(city);
      const formatted=formatWeather(data,day);
      remember(ctx,{city,day});
      const concise=d.store.profile(ctx.userId).detail==='简洁';
      await d.say(ctx,concise?formatted.split('\n').filter(v=>!/^当前|发布时间|实况发布时间/.test(v)).join('\n'):formatted);
    } catch(e) {
      if(e.code==='AMBIGUOUS'&&Array.isArray(e.candidates)&&e.candidates.length) {
        const candidates=e.candidates.slice(0,4);remember(ctx,{city,day,candidates});
        await d.say(ctx,['【请选择地区】','候选地区：'+candidates.join('；'),...candidates.map((v,i)=>(i+1)+'. '+v+'\n[天气查询]['+v+']['+day+']'),'回复“选第二个”等选择；仅对你在本会话有效5分钟。',WEATHER_QUERY_HELP].join('\n'));
      } else throw e;
    }
    return true;
  }
  return {handle,context,isFollowup,rememberQuery:(ctx,city,day)=>remember(ctx,{city:String(city).trim().slice(0,80),day})};
}
