import{normalizeBilibiliInput}from'./bilibili-client.js';
import{parseCompanionCommand}from'./companion.js';
import{dailyBilibiliPlan}from'./bilibili-proactive.js';
import{biliDay,validTarget}from'./bilibili-state.js';
export const BILIBILI_COMMANDS=['B站状态','B站登录','B站浏览','B站频率','B站时段','B站限额','刷B站','分享B站','分享视频','观看视频','视频帮助'];
export const BILIBILI_HELP='管理员私聊：[B站状态] / [B站登录] / [视频帮助] / [刷B站 目标可选] / [分享视频 链接或BV 目标可选] / [观看视频 链接或BV 目标可选]；也支持[分享视频][链接][目标]，旧[分享B站]保留。目标可用群名/好友备注/绑定别名、group:群号、private:QQ号、群号或QQ号；省略目标发本人私聊。分享发送普通图文（封面/标题/链接），观看先采样再分享；支持直接粘贴电脑/手机带标题的复制文本，引用视频卡片可说“分享到群名”“发给好友备注”；观看计入目标用户视频额度，旧[看视频][链接][问题]仍用于本会话提问。跨会话仅管理员本人私聊可用；[B站浏览][开启/关闭][目标可选]；[B站频率][180][目标可选]；[B站时段][20:00-24:00][目标可选]；[B站限额][私聊主动/群聊主动/每日浏览][数值0-100]。默认每私聊主动0–1条、每群主动1–3条、刷视频每日深读最多6条；用户来信视频独立每私聊6条/每群9条；B站评论等写操作禁用。';
// Parse only explicit video commands; copied titles are presentation, never instructions.
function copiedVideoCommand(raw,{quoted=false}={}){
 const text=String(raw||'').trim();if(text.length>6000)return null;
 const reply=quoted&&/^(?:请|帮我)?(?:(?:把|将)(?:这(?:个|条)(?:视频|卡片)?|它))?(?:发送|分享|转发|发)(?:视频|卡片)?(?:一下)?(?:给|到)\s*(.{1,80}?)\s*[。！!]*$/.exec(text);
 if(reply)return{command:'分享视频',args:['这个视频',reply[1]]};
 const head=/^[\[【]\s*(分享视频|观看视频|分享B站)(?=\s|[\]】])/.exec(text)||/^(?:请|帮我)?(分享视频|观看视频|分享B站)\s+/.exec(text);
 if(!head)return null;
 const command=head[1],explicit=/^[\[【]/.test(text);let body=text.slice(head[0].length);
 if(explicit){const close=text[0]==='['?']':'】';if(!body.endsWith(close))return null;body=body.slice(0,-1);}
 const links=[...body.matchAll(/https?:\/\/[^\s<>"'\[\]【】{}]+/gu)];
 if(links.length){
  if(links.length!==1)return{command,args:[],parseError:'一次只分享一个视频链接，多个链接请分开发送'};
  const match=links[0],ref=normalizeBilibiliInput(match[0].replace(/[，。；！、）)]+$/,'').replace(/&amp;/g,'&'));
  if(!ref)return{command,args:[],parseError:'请使用有效的B站视频链接或b23.tv短链'};
  const dest=body.slice(match.index+match[0].length).replace(/^[\s\]】\[【]+|[\s\]】\[【]+$/g,'').replace(/^(?:给|到)\s*/,'').trim();
  if(dest.length>80)return{command,args:[],parseError:'分享目标过长，请用群号、QQ号或明确名称'};
  return{command,args:[ref.url,...(dest?[dest]:[])]};
 }
 const parsed=parseCompanionCommand(text);
 if(quoted&&parsed?.command===command&&(parsed.args||[]).length<=1&&!normalizeBilibiliInput(parsed.args[0])&&!/^这(?:个|条)/.test(parsed.args[0]||''))return{command,args:['这个视频',...(parsed.args||[])]};
 return null;
}
export function mapBilibiliText(raw){
 const text=String(raw||'').trim();if(text.length>1200||/教程|示例|假如|如果|他说|她说|[“”「」『』]/.test(text))return null;
 const video=/^(?:请|帮我)?(分享视频|观看视频)\s+(https:\/\/[^\s]+|BV[A-Za-z0-9]{10}|这(?:个|条)(?:B站)?视频)(?:\s+(?:(?:给|到)\s*)?(.{1,80}?))?[。！! ]*$/.exec(text);
 if(video)return{command:video[1],args:[video[2],...(video[3]?[video[3]]:[])]};
 const limit=/^(?:把|将|设置|修改)?\s*(私聊|群聊)(?:每天|每日)?(?:主动)?分享(?:上限|限制|额度)?(?:改成|改为|设为|设置为|为|到)\s*(\d+)\s*条?[。！! ]*$/.exec(text);
 if(limit)return{command:'B站限额',args:[limit[1]+'主动',limit[2]]};
 const browse=/^(?:每天|每日)(?:最多)?(?:浏览|刷)(?:B站|b站|视频)?(?:最多|改成|改为|设为)?\s*(\d+)\s*条[。！! ]*$/.exec(text);
 if(browse)return{command:'B站限额',args:['每日浏览',browse[1]]};
 if(/^(?:去|现在|主动|帮我)?(?:刷|逛)(?:一下)?[Bb]站(?:视频)?[。！! ]*$/.test(text))return{command:'刷B站',args:[]};
 const share=/^(?:请|帮我)?(?:把|将)?\s*(https:\/\/[^\s]+|BV[A-Za-z0-9]{10}|这(?:个|条)(?:B站)?视频)\s*(?:分享|转发)(?:给|到)\s*(.{1,80}?)\s*[。！! ]*$/.exec(text);
 if(share)return{command:'分享B站',args:[share[1],share[2]]};
 const share2=/^(?:请|帮我)?(?:分享|转发)\s*(https:\/\/[^\s]+|BV[A-Za-z0-9]{10}|这(?:个|条)(?:B站)?视频)(?:\s*(?:给|到)\s*(.{1,80}?))?[。！! ]*$/.exec(text);
 if(share2)return{command:'分享B站',args:[share2[1],...(share2[2]?[share2[2]]:[])]};
 return null;
}
export function createBilibiliController(d){
 const {state}=d,now=d.now||Date.now,versions=new Map();let busy=false,ticking=false;
 const enabled=()=>d.isEnabled?.()!==false;
 const roleVersion=()=>d.getRoleSnapshot?.()?.version||'';
 const epoch=key=>versions.get(key)||0;
 const cancel=key=>versions.set(key,epoch(key)+1);
 function status(key){
  const s=state.read(),t=state.target(key,s),a=d.login.status();
  return '【B站状态】\n'+(a.loggedIn?'已保存登录态（是否有效以实际读取为准）':'未登录')+'\nB站评论/回复/私信/动态/点赞/投币/关注：禁用\n当前QQ人物卡：'+(d.getRoleSnapshot?.()?.name||'未设置')+
   '\n自动浏览：'+(t.enabled?'开启':'关闭')+'｜'+(t.schedule==='daily'?'按日随机计划':'每'+t.interval+'分钟')+'｜北京时间'+t.start+':00–'+t.end+':00\n每日主动分享上限：每私聊'+s.limits.privateDaily+'条、每群'+s.limits.groupDaily+'条；本会话今日已占用'+state.shareCount(key,s)+'条\n刷视频深读：今日'+state.readCount(s)+'/'+Math.min(6,s.limits.browseDaily)+'条（刷B站手动与自动共用；用户来信视频另计每私聊6条/每群9条）\n手动指定分享不占主动额度，仍受QQ发送限流。\n'+(d.sourceStatus?.()||'')+
   (busy?'\n当前有B站任务处理中。':'');
 }
 async function target(raw,ctx){
  if(!raw)return ctx.sourceKey;
  raw=String(raw).trim();
  const group=/^(?:群聊|群)\s*[:：]?\s*([1-9]\d{0,11})$/.exec(raw),person=/^(?:私聊|好友|QQ)\s*[:：]?\s*([1-9]\d{0,11})$/i.exec(raw);
  let key=group?'group:'+group[1]:person?'private:'+person[1]:raw;
  if(!validTarget(key)){const r=await d.resolveTarget(raw);if(!r?.ok)throw Error(r?.message||'分享目标不明确');key=r.key||(r.kind+':'+r.targetId);}
  if(!validTarget(key)||!d.isAllowed(key))throw Error('目标无效或不在当前白名单内');
  return key;
 }
 async function work(ctx,kind,payload){
  if(busy)throw Error('B站任务正在处理，请稍后重试');
  if(!enabled()||!d.isAllowed(ctx.sourceKey)||!d.isAllowed(payload.targetKey||ctx.sourceKey))throw Error('当前会话权限已关闭');
  const account=d.getAccountVersion?.(),ver=roleVersion(),ep=epoch(ctx.sourceKey),revision=state.read().revision,dest=payload.targetKey||ctx.sourceKey,targetEp=epoch(dest);
  if(!ver)throw Error('当前QQ没有有效人物卡，未启动浏览或分享');
  const stillSelected=()=>{if(!payload.automatic||!state.read().autoSelect)return true;const selected=d.getProactiveTargets?.();return Array.isArray(selected)&&selected.includes(dest);};
  const authorize=()=>stillSelected()&&enabled()&&d.isAllowed(ctx.sourceKey)&&d.isAllowed(dest)&&epoch(ctx.sourceKey)===ep&&epoch(dest)===targetEp&&roleVersion()===ver&&d.getAccountVersion?.()===account&&state.read().revision===revision;
  busy=true;try{return await d[kind](ctx,{...payload,authorize});}finally{busy=false;}
 }
 async function handle(ctx,raw){
  const parsed=typeof raw==='object'?raw:copiedVideoCommand(raw,{quoted:!!ctx.quotedId})||parseCompanionCommand(raw),cmd=BILIBILI_COMMANDS.includes(parsed?.command)?parsed:mapBilibiliText(raw);
  if(!BILIBILI_COMMANDS.includes(cmd?.command))return false;
  try{
   if(String(ctx.userId)!==String(d.ownerQQ()))throw Error('B站控制和跨会话分享仅管理员可用');
   if(!enabled()||!d.isAllowed(ctx.sourceKey))throw Error('当前B站或会话权限已关闭');
   if(cmd.parseError)throw Error(cmd.parseError);
   const c=cmd.command,a=cmd.args||[];
   if((['分享视频','观看视频','视频帮助'].includes(c)||(c==='刷B站'&&a.length)||(c==='分享B站'&&a[1]))&&ctx.sourceKey!=='private:'+String(d.ownerQQ()))throw Error('请在管理员本人私聊使用视频控制或指定分享目标');
   if(c==='视频帮助'){if(a.length)throw Error('[视频帮助]无需参数');await d.say(ctx,BILIBILI_HELP);return true;}

   if(c==='B站状态'){if(a.length)throw Error('[B站状态]无需参数');await d.say(ctx,status(ctx.sourceKey));return true;}
   if(c==='B站登录'){
    if(!ctx.sourceKey.startsWith('private:')||String(ctx.userId)!==ctx.sourceKey.split(':')[1])throw Error('请在管理员本人私聊扫码登录');
    if(a.length)throw Error('[B站登录]无需参数');
    await d.login.show(ctx);return true;
   }
   if(c==='刷B站'){if(a.length>1)throw Error('[刷B站][目标可选]');const key=await target(a[0],ctx),result=await work(ctx,'browse',{automatic:false,targetKey:key});if(result?.selected===false)await d.say(ctx,'这轮没有选到合适的视频，没有勉强分享。');else if(key!==ctx.sourceKey)await d.say(ctx,'已按要求浏览并分享视频到'+key+'。');return true;}
   if(['分享B站','分享视频','观看视频'].includes(c)){
    if(a.length<1||a.length>2)throw Error('['+c+' 链接或BV号 目标可选]；含空格的名称请用['+c+'][链接][完整目标名]');
    const key=await target(a[1],ctx);let input=a[0];
    if(/^这(?:个|条)/.test(input)){input=await d.recentVideo?.(ctx);if(!input)throw Error('没有你在本会话的明确视频，请带上链接或引用原消息');}
    await work(ctx,c==='观看视频'?'watch':'share',{input,targetKey:key,automatic:false});
    if(key!==ctx.sourceKey)await d.say(ctx,'已按要求'+(c==='观看视频'?'观看并':'')+'分享视频到'+key+'。');
    return true;
   }
   if(c==='B站限额'){
    if(!ctx.sourceKey.startsWith('private:'))throw Error('请在管理员私聊调整B站限额');
    const k={'私聊主动':'privateDaily','群聊主动':'groupDaily','每日浏览':'browseDaily'}[a[0]],n=Number(a[1]);
    if(a.length!==2||!k||!/^\d+$/.test(a[1])||!Number.isInteger(n)||n>(k==='browseDaily'?6:100))throw Error('每日浏览最高6条；其他限额0–100整数');
    state.update(s=>{s.limits[k]=n;},{settings:true});
    await d.say(ctx,'已设置'+a[0]+'每日上限为'+n+'；0表示暂停该项。');return true;
   }
   if(a.length<1||a.length>2)throw Error('请填写设置值和可选QQ目标');
   const key=await target(a[1],ctx);
   if(a[1]&&!ctx.sourceKey.startsWith('private:'))throw Error('请在管理员私聊按目标调整');
   if(c==='B站浏览'){
    if(!['开启','关闭','开','关'].includes(a[0]))throw Error('[B站浏览][开启/关闭][目标可选]');
    const on=['开启','开'].includes(a[0]);if(!on)cancel(key);
    state.update(s=>{s.targets[key]={...state.target(key,s),enabled:on,dueAt:on?now()+state.target(key,s).interval*60000:0};},{settings:true});
   }else if(c==='B站频率'){
    const n=Number(a[0]);if(!/^\d+$/.test(a[0])||!Number.isInteger(n)||n<30||n>1440)throw Error('频率须为30–1440分钟的整数');
    state.update(s=>{s.targets[key]={...state.target(key,s),interval:n,schedule:'interval',plan:undefined,dueAt:now()+n*60000};},{settings:true});
   }else if(c==='B站时段'){
    const m=/^(\d{1,2}):00-(\d{1,2}):00$/.exec(a[0]),start=Number(m?.[1]),end=Number(m?.[2]);if(!m||start<0||start>23||end<1||end>24||start>=end)throw Error('时段须为同一天的整点范围，如20:00-24:00');
    state.update(s=>{s.targets[key]={...state.target(key,s),start,end,plan:undefined};},{settings:true});
   }
   await d.say(ctx,'已更新'+key+'的B站设置。\n'+status(key));return true;
  }catch(e){await d.say(ctx,'未完成：'+String(e.message||'B站操作失败').slice(0,220));return true;}
 }
 async function tick(){
  if(ticking||busy||!enabled()||!d.login.status().loggedIn)return;
  ticking=true;try{
   let s=state.read();if(state.readCount(s)>=Math.min(6,s.limits.browseDaily))return;
   const selected=s.autoSelect?new Set(await d.getProactiveTargets?.()||[]):null;
   if(selected){
    const missing=[...selected].filter(k=>validTarget(k)&&d.isAllowed(k)&&!s.targets[k]);
    if(missing.length)state.update(v=>{for(const key of missing)v.targets[key]={...state.target(key,v),enabled:true,schedule:'daily'};});
    s=state.read();
   }
   const eligible=Object.entries(s.targets).filter(([key,t])=>t.enabled&&(!selected||selected.has(key))&&d.isAllowed(key)&&state.shareCount(key,s)<state.shareLimit(key,s));
   for(const[key,t]of eligible)if(t.schedule==='daily'&&t.plan?.day!==biliDay(now())){
    const plan=dailyBilibiliPlan(key,t,{now:now(),random:d.random||Math.random,limit:state.shareLimit(key,s)});
    state.update(v=>{if(v.targets[key])v.targets[key].plan=plan;});
   }
   s=state.read();const candidates=eligible.map(([key])=>[key,s.targets[key]]).filter(([key,t])=>{
    const hour=Number(new Date(now()+8*3600000).toISOString().slice(11,13));
    if(hour<t.start||hour>=t.end||!d.canNotify(key))return false;
    if(t.schedule==='daily')return t.plan?.day===biliDay(now())&&t.plan.cursor<t.plan.slots.length&&t.plan.slots[t.plan.cursor]<=now()&&now()-Number(t.lastAttemptAt||0)>=3600000;
    return t.dueAt<=now();
   });
   candidates.sort(([ka,ta],[kb,tb])=>{
    const firstA=ka.startsWith('group:')&&state.shareCount(ka,s)===0?0:1,firstB=kb.startsWith('group:')&&state.shareCount(kb,s)===0?0:1;
    return firstA-firstB||(ta.lastAttemptAt||0)-(tb.lastAttemptAt||0)||ka.localeCompare(kb);
   });
   const next=candidates[0];if(!next)return;const[key,t]=next;
   const ctx={sourceKey:key,userId:String(d.ownerQQ()),sender:'管理员',directed:true,message:[]};
   state.update(v=>{const target=v.targets[key];if(!target)return;
    target.lastAttemptAt=now();target.dueAt=now()+t.interval*60000;
    if(target.schedule==='daily')while(target.plan.cursor<target.plan.slots.length&&target.plan.slots[target.plan.cursor]<=now())target.plan.cursor++;
   });
   try{await work(ctx,'browse',{automatic:true,targetKey:key});}catch{d.audit?.('[bilibili] 本次自动浏览未完成，不立即重试或集中补发');}
  }finally{ticking=false;}
 }
 return{handle,tick,cancel,status,isBusy:()=>busy};
}
