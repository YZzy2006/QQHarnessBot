import {utilityId,utilityText} from './utility-store.js';
import {rankRecords,weekStart} from './utility-content.js';
import {bjDate,bjClock,formatWeather} from './life-services.js';
import {PRIVATE_REPORT_MARKER} from './private-report-guard.js';
const COMMANDS=new Set(['今日安排','本周回忆','记录报错','查报错','报错详情','删除报错','报错验证','生成公告','公告预览','发布公告','删除公告']);
export function createUtilityOwner(d) {
  const now=d.now||Date.now,publishing=new Set();
  const uid=()=>String(d.ownerQQ()),ownerKey=()=> 'private:'+uid();
  async function ownerSay(ctx,text,options={}) {
    await d.say({...ctx,sourceKey:ownerKey()},text,options);
    if(ctx.sourceKey.startsWith('group:'))await d.say(ctx,'已私聊管理员，私人内容不在群内展示。');
  }
  const facts=()=>({notes:[],tasks:[],anniversaries:[],memories:[],...(d.ownerFacts?.()||{})});
  async function daily() {
    const f=facts(),p=d.store.profile(uid()),start=Date.parse(bjDate(now())+'T00:00:00+08:00'),end=start+86400000;
    const tasks=f.tasks.filter(t=>!t.paused&&Number(t.at)>=start&&Number(t.at)<end);
    const todos=[...f.notes.filter(v=>!v.done),...p.todos.filter(v=>!v.done)];
    const anniversaries=f.anniversaries.filter(v=>!v.completedAt&&Number(v.nextAt)>=start&&Number(v.nextAt)<end);
    const city=p.city||d.ownerCity?.();let weather='未设置本人城市，可用[我的城市][地区]设置。';
    if(city){try{weather=formatWeather(await d.life.weather(city),'今天');}catch{weather='天气暂时无法获取，其他安排仍如下。';}}
    return ['【今日安排】'+bjDate(now()),weather,'待办：',...(todos.slice(0,15).map(v=>'• '+v.text)),...(!todos.length?['暂无未完成待办']:[]),
      '今日原提醒/任务（只读）：',...tasks.slice(0,10).map(v=>'• '+bjClock(v.at)+' '+v.text),...(!tasks.length?['无今日待执行任务']:[]),
      '纪念日：',...anniversaries.slice(0,10).map(v=>'• '+v.name+' '+bjClock(v.nextAt)),...(!anniversaries.length?['今天没有已设置的纪念日']:[])].join('\n');
  }
  function weeklyData() {
    const f=facts(),start=weekStart(now());
    const memories=f.memories.filter(v=>Number(v.createdAt)>=start&&Number(v.createdAt)<=now()).slice(-30).map(v=>({text:v.text,note:v.note,correction:v.correction,at:v.createdAt}));
    const completed=[...f.notes,...d.store.profile(uid()).todos].filter(v=>v.done&&Number(v.completedAt||v.updatedAt||v.createdAt)>=start&&Number(v.completedAt||v.updatedAt||v.createdAt)<=now()).slice(-30).map(v=>({text:v.text,at:v.completedAt||v.updatedAt||v.createdAt}));
    return {start:bjDate(start),end:bjDate(now()),memories,completed};
  }
  async function weekly() {
    const data=weeklyData(),{memories,completed}=data;
    let body;
    if(!memories.length&&!completed.length)body='这周还没有明确保存的回忆或已完成事项。等你愿意留下时，我再把它们整理成这一周的回顾。';
    else {
      try{body=await d.compose('weekly',data);}
      catch{body='本周保存的真实片段：\n'+memories.map(v=>'• '+(v.correction||v.text)).join('\n')+'\n已完成事项：\n'+completed.map(v=>'• '+v.text).join('\n');}
    }
    if(JSON.stringify(weeklyData())!==JSON.stringify(data))throw Error('周记来源已变化，请重新生成，不发送旧快照');
    return PRIVATE_REPORT_MARKER+'\n'+data.start+' 至 '+data.end+'\n'+utilityText(body,5000);
  }
  async function handle(ctx,cmd) {
    const c=cmd?.command,a=cmd?.args||[];
    if(!COMMANDS.has(c))return false;
    if(String(ctx.userId)!==uid())throw Error('仅机器人管理员可使用此私人功能');
    if(c==='今日安排'||c==='本周回忆') {
      if(a.length)throw Error('此命令无需额外参数');
      await ownerSay(ctx,c==='今日安排'?await daily():await weekly(),{privateReport:c==='本周回忆'});
    } else if(c==='记录报错') {
      if(a.length<4||a.length>5||a.slice(0,4).some(v=>!v.trim()))throw Error('[记录报错][标题][现象][原因][解决办法][环境（可选）]');
      const item={id:utilityId('e'),title:utilityText(a[0],100),symptom:d.redact(utilityText(a[1],1500)),cause:d.redact(utilityText(a[2],1500)),solution:d.redact(utilityText(a[3],1500)),environment:utilityText(a[4],100),verified:false,createdAt:now()};
      d.store.editOwner(uid(),o=>{if(o.errors.length>=200)throw Error('报错档案已满');o.errors.push(item);});
      await ownerSay(ctx,'已保存私人报错档案 '+item.id+'，状态为待验证；验证后可发[报错验证]['+item.id+'][已解决]。');
    } else if(c==='查报错'||c==='报错详情') {
      const list=d.store.owner(uid()).errors;
      const rows=c==='报错详情'?list.filter(v=>v.id===a[0]):rankRecords(list,a[0],['title','symptom','cause','solution','environment']);
      await ownerSay(ctx,'【私人报错档案】\n'+(rows.map(v=>v.id+' '+v.title+'（'+(v.verified?'已验证':'待验证')+'）\n现象：'+v.symptom+'\n原因：'+v.cause+'\n办法：'+v.solution+(v.environment?'\n环境：'+v.environment:'')).join('\n\n')||'没有找到匹配档案'));
    } else if(c==='报错验证') {
      if(a.length!==2||!['已解决','待验证'].includes(a[1]))throw Error('[报错验证][e_完整ID][已解决或待验证]');
      d.store.editOwner(uid(),o=>{const e=o.errors.find(v=>v.id===a[0]);if(!e)throw Error('档案ID不存在');e.verified=a[1]==='已解决';});
      await ownerSay(ctx,'已更新该档案的验证状态。');
    } else if(c==='删除报错'||c==='删除公告') {
      if(a.length!==2||a[1]!=='确认')throw Error('删除须完整ID和末尾[确认]');
      if(c==='删除公告'&&publishing.has(a[0]))throw Error('该公告正在发送，不能同时删除草稿');
      d.store.editOwner(uid(),o=>{const list=c==='删除报错'?'errors':'drafts';if(!o[list].some(v=>v.id===a[0]))throw Error('完整ID不存在');o[list]=o[list].filter(v=>v.id!==a[0]);});
      await ownerSay(ctx,'已删除指定私人记录。');
    } else if(c==='生成公告') {
      let content=a[0];
      if(a.length>1)throw Error('[生成公告][本次实际改动]；也可引用改动说明后发[生成公告]');
      if(!content){const q=await d.quote(ctx);content=await d.readMessage(q);}
      if(!content.trim())throw Error('请填写或引用本次实际改动');
      const body=utilityText(await d.compose('announcement',{changes:d.redact(content.slice(0,6000))}),3000);
      if(!body)throw Error('没有生成有效公告，未发布');
      const item={id:utilityId('a'),text:body,createdAt:now(),target:ctx.sourceKey.startsWith('group:')?ctx.sourceKey:null};
      d.store.editOwner(uid(),o=>{if(o.drafts.length>=100)throw Error('公告草稿已满');o.drafts.push(item);});
      await ownerSay(ctx,'【公告草稿】'+item.id+'\n'+body+'\n尚未发布。确认目标后用[发布公告]['+item.id+']'+(item.target?'[确认]':'[group:群号][确认]')+'。');
    } else if(c==='公告预览') {
      const rows=d.store.owner(uid()).drafts.filter(v=>!a[0]||v.id===a[0]).slice(-10);
      await ownerSay(ctx,'【公告草稿】\n'+(rows.map(v=>v.id+' '+(v.completedAt?'已发布':'未发布')+'\n目标：'+(v.target||'尚未指定')+'\n'+v.text).join('\n\n')||'没有匹配草稿'));
    } else if(c==='发布公告') {
      if(![2,3].includes(a.length)||a.at(-1)!=='确认')throw Error('发布须完整草稿ID、目标（如未绑定）及末尾[确认]');
      const item=d.store.owner(uid()).drafts.find(v=>v.id===a[0]);if(!item)throw Error('草稿ID不存在');
      if(item.completedAt)throw Error('该公告已发布，不会重复发送');
      if(publishing.has(item.id))throw Error('该公告正在发布');
      const target=a.length===3?a[1]:item.target;
      if(!/^group:[1-9]\d{0,11}$/.test(target||'')||!d.isAllowed(target))throw Error('请明确指定允许的群目标 group:群号');
      if(item.target&&item.target!==target)throw Error('目标与草稿绑定的群不同，请重新生成该群草稿');
      publishing.add(item.id);
      try {
        if(await d.say({...ctx,sourceKey:target},item.text)===false)throw Error('发布未确认成功，草稿保留');
        d.store.editOwner(uid(),o=>{const current=o.drafts.find(v=>v.id===item.id);if(current){current.completedAt=now();current.target=target;}});
        await ownerSay(ctx,'公告已发布到'+target+'。');
      } finally {publishing.delete(item.id);}
    }
    return true;
  }
  return {handle,daily,weekly,ownerSay};
}
