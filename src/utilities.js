import {createUtilityStore,utilityText} from './utility-store.js';
import {checkedQuote,weekStart} from './utility-content.js';
import {parseCompanionCommand} from './companion.js';
import {createUtilityWeather} from './utility-weather.js';
import {createUtilityLibrary} from './utility-library.js';
import {createUtilityOwner} from './utility-owner.js';
import {createUtilityAttachments} from './utility-attachments.js';
import {bjDate,bjClock} from './life-services.js';
import {createLocalRequestQueue} from './local-request-queue.js';
export const UTILITIES_HELP=[
  '【扩展功能】群查询回复本群；私人内容只发本人。订阅默认关闭。',
  '[我的城市][广州] / [我的设置] / [查询偏好][简洁] / [我的安静时段][22-8]',
  '天气后可追问“那明天呢”“换成韶关”“选第二个”（本人、本会话5分钟）',
  '地点后可追问“换腾讯的”“选第二个”“发这个”（本人、本会话5分钟）；忙时排队，超时明确说明。',
  '引用原消息：[群知识投稿][标题]；[群知识][关键词] / [群知识详情][k_ID]',
  '管理员：[群知识待审] / [群知识审核][k_ID][通过或拒绝] / [群知识过期][k_ID]',
  '管理员：[今日安排] / [今日安排订阅][08:00或关闭]',
  '管理员：[本周回忆] / [周记订阅][周日20:00或关闭]；周记私聊且不入聊天记忆',
  '引用截图：[截图待办] → [确认截图待办][p_ID][确认]；[我的待办] / [完成截图待办][t_ID]',
  '引用旧/新文件：[文件暂存][旧版] / [文件暂存][新版] → [文件对比][旧版][新版]',
  '管理员：[记录报错][标题][现象][原因][办法] / [查报错][关键词] / [报错详情][e_ID]',
  '管理员：[生成公告][实际改动] → [公告预览][a_ID] → [发布公告][a_ID][group:群号][确认]',
  '[推荐歌曲或推荐电影][标题][链接][理由] / [歌单或片单][关键词] / [评价推荐][s_ID][评价]',
  '[抽一首歌] / [抽一部电影]；作者/管理员可[删除推荐][s_ID][确认]',
  '[兴趣主题][Java,AI] / [兴趣简报][主题（可选）] / [简报订阅][08:30或关闭]',
  '所有完整ID以实际返回为准；删除/发布/截图保存必须明确确认。'
].join('\n');
export function createUtilities(input) {
  const known=new Set(['天气','天气查询','我的城市','我的设置','查询偏好','我的安静时段','扩展帮助','群知识投稿','群知识审核','群知识待审','群知识','群知识详情','群知识过期','删除群知识','推荐歌曲','推荐电影','歌单','片单','评价推荐','删除推荐','抽一首歌','抽一部电影','今日安排','本周回忆','记录报错','查报错','报错详情','删除报错','报错验证','生成公告','公告预览','发布公告','删除公告','截图待办','确认截图待办','我的待办','完成截图待办','删除截图待办','文件暂存','文件对比','清除文件暂存','兴趣主题','兴趣简报','今日安排订阅','周记订阅','简报订阅']);
  const now=input.now||Date.now,store=input.store||createUtilityStore(input),queue=createLocalRequestQueue({now}),pendingWeather=new Map();
  const send=input.send||((key,text,options)=>input.say({sourceKey:key},text,options));
  const d={...input,store,now,say:async(ctx,text,options={})=>{
    if(!input.isAllowed(ctx.sourceKey))throw Error('目标不在当前模式白名单内');
    if(await send(ctx.sourceKey,input.redact(String(text)),{manual:true,noMemory:true,...options})===false)throw Error('回复未确认送达，请稍后重试');
    return true;
  }};
  d.quote=async ctx=>{if(!ctx.quotedId)throw Error('请先引用当前会话的原消息');return checkedQuote(ctx,await input.getMessage(ctx.quotedId));};
  const weather=createUtilityWeather(d),library=createUtilityLibrary(d),owner=createUtilityOwner(d),attachments=createUtilityAttachments(d);
  const enabled=()=>input.isEnabled?.()!==false;
  async function news(uid,topic) {
    const topics=topic?[topic]:store.profile(uid).topics;
    if(!topics.length)throw Error('先设置[兴趣主题][Java,AI]，或直接[兴趣简报][Java]');
    if(topics.join(' ').length>120)throw Error('主题过长');
    const result=await input.search(topics.join(' '));
    const rows=result.results||[];
    return ['【兴趣简报】'+bjClock(now()),'主题：'+topics.join('、')+'｜检索来源：'+result.source,
      '有发布时间的资料仅保留近7天；时间未知单独标注，检索结果不等于事实已独立核实。',
      ...(rows.length?rows.map((r,i)=>(i+1)+'. '+r.title+'\n'+r.snippet+'\n发布时间：'+r.dateLabel+'\n来源：'+r.url):['本次没有找到符合范围的资料，不编造新闻。'])].join('\n\n');
  }
  async function handle(ctx,inputText) {
    if(!enabled()||!input.isAllowed(ctx.sourceKey)||!/^[1-9]\d{0,11}$/.test(String(ctx.userId)))return false;
    const cmd=parseCompanionCommand(inputText),actor=ctx.sourceKey+':'+ctx.userId;
    const weatherCommand=['天气','天气查询'].includes(cmd?.command);
    const followup=weather.isFollowup(inputText)&&(weather.context(ctx)||pendingWeather.has(actor));
    if(!known.has(cmd?.command)&&!followup)return false;
    if(weatherCommand)pendingWeather.set(actor,(pendingWeather.get(actor)||0)+1);
    try {
      return await queue.run(actor,async()=>{
        if(!input.isAllowed(ctx.sourceKey))return true;
        if(!enabled()){await d.say(ctx,'这条排队请求尚未执行：扩展功能已关闭。');return true;}
        const handled=await execute(ctx,inputText);
        if(!handled&&followup){await d.say(ctx,'上一条天气查询没有留下可用结果，请补充城市后再查。');return true;}
        return handled;
      },{onQueued:()=>d.say(ctx,'上一条请求还在处理，这条已排队；轮到后直接给结果，等待超过2分钟将不再执行。')});
    } catch(e) {
      if(input.isAllowed(ctx.sourceKey))await d.say(ctx,'未完成：'+input.redact(String(e.message||'扩展操作失败')).slice(0,300));
      return true;
    } finally {
      if(weatherCommand){const n=pendingWeather.get(actor)-1;if(n)pendingWeather.set(actor,n);else pendingWeather.delete(actor);}
    }
  }
  async function execute(ctx,inputText) {
    const cmd=parseCompanionCommand(inputText),c=cmd?.command,a=cmd?.args||[];
    try {
      if(c==='扩展帮助'){await d.say(ctx,UTILITIES_HELP);return true;}
      if(await weather.handle(ctx,cmd,inputText)||await library.handle(ctx,cmd)||await owner.handle(ctx,cmd)||await attachments.handle(ctx,cmd))return true;
      if(c==='兴趣主题') {
        const topics=String(a[0]||'').split(/[,，、]/).map(v=>utilityText(v,21)).filter(Boolean);
        if(a.length!==1||!topics.length||topics.length>5||topics.some(v=>v.length>20))throw Error('[兴趣主题][Java,AI,游戏]；最多5个，每个20字以内');
        if(topics.some(v=>input.redact(v)!==v))throw Error('兴趣主题包含敏感信息，未保存或提交检索');
        store.editProfile(ctx.userId,p=>{p.topics=[...new Set(topics)];});await d.say(ctx,'已保存你本人的兴趣主题，尚未自动订阅。');return true;
      }
      if(c==='兴趣简报'){if(a.length>1)throw Error('[兴趣简报][主题（可选）]');if(a[0]&&input.redact(a[0])!==a[0])throw Error('查询包含敏感信息，未提交检索');await d.say(ctx,await news(ctx.userId,a[0]));return true;}
      if(['今日安排订阅','周记订阅','简报订阅'].includes(c)) {
        const kind=c==='今日安排订阅'?'daily':c==='周记订阅'?'weekly':'news';
        if(kind!=='news'&&String(ctx.userId)!==String(input.ownerQQ()))throw Error('仅管理员可订阅私人安排和周记');
        if(!input.isAllowed('private:'+ctx.userId))throw Error('本人私聊不在当前白名单，不能订阅通知');
        if(a.length!==1)throw Error('请填写时间，如[简报订阅][08:30]，关闭用[关闭]');
        if(a[0]==='关闭'){store.editProfile(ctx.userId,p=>{delete p.subscriptions[kind];delete p.deliveries[kind];});await d.say(ctx,'已关闭该项扩展订阅，不影响旧任务。');return true;}
        const m=kind==='weekly'?/^(?:周|星期)([一二三四五六日天])(\d{1,2}):(\d{2})$/.exec(a[0]):/^(\d{1,2}):(\d{2})$/.exec(a[0]);
        const hour=Number(m?.[kind==='weekly'?2:1]),minute=Number(m?.[kind==='weekly'?3:2]);
        if(!m||hour>23||minute>59)throw Error(kind==='weekly'?'格式：[周记订阅][周日20:00]':'时间格式08:30，按北京时间');
        store.editProfile(ctx.userId,p=>{p.subscriptions[kind]={hour,minute,createdAt:now(),...(kind==='weekly'?{day:('一二三四五六'.indexOf(m[1])+1)%7}:{})};delete p.deliveries[kind];});
        await d.say(ctx,'已开启本人私聊订阅，时间为北京时间'+a[0]+'；服从安静时段、暂停和发送额度。');return true;
      }
      return false;
    } catch(e) {
      await d.say(ctx,'未完成：'+input.redact(String(e.message||'扩展操作失败')).slice(0,300));
      return true;
    }
  }
  let ticking=false;
  async function tick() {
    if(ticking||!enabled())return;ticking=true;
    try {
      for(const [uid,p] of Object.entries(store.read().profiles)) {
        const key='private:'+uid,date=bjDate(now()),clock=new Date(now()+8*3600000),hour=clock.getUTCHours();
        const quiet=p.quietStart<p.quietEnd?hour>=p.quietStart&&hour<p.quietEnd:hour>=p.quietStart||hour<p.quietEnd;
        if(quiet||!input.isAllowed(key)||!input.canNotify(key))continue;
        for(const [kind,sub] of Object.entries(p.subscriptions)) {
          if(kind!=='news'&&uid!==String(input.ownerQQ()))continue;
          const due=Date.parse(date+'T'+String(sub.hour).padStart(2,'0')+':'+String(sub.minute).padStart(2,'0')+':00+08:00');
          if(now()<due||sub.createdAt>due||kind==='weekly'&&clock.getUTCDay()!==sub.day)continue;
          const period=kind==='weekly'?bjDate(weekStart(now())):date,prev=store.profile(uid).deliveries[kind];
          if(prev?.period===period&&(prev.done||prev.retryAt>now()))continue;
          try {
            const text=kind==='daily'?await owner.daily():kind==='weekly'?await owner.weekly():await news(uid);
            const latest=store.profile(uid).subscriptions[kind];
            if(!latest||JSON.stringify(latest)!==JSON.stringify(sub)||!input.canNotify(key))continue;
            if(await send(key,input.redact(text),{manual:false,noMemory:true,privateReport:kind==='weekly'})===false)throw Error('send failed');
            store.editProfile(uid,v=>{v.deliveries[kind]={period,done:true,at:now()};});
          } catch {
            store.editProfile(uid,v=>{v.deliveries[kind]={period,done:false,retryAt:now()+120000};});
          }
        }
        for(const t of p.todos.filter(v=>!v.done&&!v.notifiedAt&&v.dueAt&&v.dueAt<=now()&&!(v.retryAt>now())).slice(0,3)) {
          const current=store.profile(uid).todos.find(v=>v.id===t.id&&!v.done&&!v.notifiedAt);
          if(!current||!input.canNotify(key))continue;
          if(await send(key,'【截图待办提醒】'+current.text+'\n原识别时间：'+bjClock(current.dueAt),{manual:false,noMemory:true})!==false)
            store.editProfile(uid,v=>{const row=v.todos.find(r=>r.id===t.id);if(row&&!row.done)row.notifiedAt=now();});
          else store.editProfile(uid,v=>{const row=v.todos.find(r=>r.id===t.id);if(row&&!row.done)row.retryAt=now()+120000;});
        }
      }
    } catch {input.audit?.('[utilities] 调度或存储检查未完成，将在下次检查重试');}
    finally {ticking=false;}
  }
  return {handle,tick,store,weather,owner,weatherPending:ctx=>pendingWeather.has(ctx.sourceKey+':'+ctx.userId)};
}
