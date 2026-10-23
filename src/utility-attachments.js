import {utilityId,utilityText} from './utility-store.js';
import {compareDocuments,parseTaskPreview} from './utility-content.js';
import {parseScheduledTime} from './time-parse.js';
import {bjClock} from './life-services.js';
const COMMANDS=new Set(['截图待办','确认截图待办','我的待办','完成截图待办','删除截图待办','文件暂存','文件对比','清除文件暂存']);
export function createUtilityAttachments(d) {
  const previews=new Map(),documents=new Map(),now=d.now||Date.now;
  const actor=ctx=>ctx.sourceKey+':'+ctx.userId;
  function prune(){for(const [k,v] of previews)if(now()-v.at>600000)previews.delete(k);for(const [k,v] of documents)if(now()-v.at>900000)documents.delete(k);}
  async function handle(ctx,cmd) {
    const c=cmd?.command,a=cmd?.args||[];if(!COMMANDS.has(c))return false;
    prune();const key=actor(ctx);
    if(c==='截图待办') {
      if(a.length)throw Error('引用截图后发[截图待办]，无需额外参数');
      const q=await d.quote(ctx),raw=await d.extractTasks(q),tasks=parseTaskPreview(raw).map(t=>{
        const parsed=t.dueText?parseScheduledTime(t.dueText,now()):null;
        return {...t,text:d.redact(t.text),dueAt:parsed?.ok&&!parsed.repeat&&parsed.at>now()?parsed.at:0};
      });
      if(previews.size>=200)throw Error('待确认截图较多，请稍后重试');
      const id=utilityId('p');previews.set(id,{actor:key,at:now(),tasks});
      await d.say(ctx,['【截图待办预览】'+id,...tasks.map((t,i)=>(i+1)+'. '+t.text+'\n识别时间：'+(t.dueText||'未明确')+'；'+(t.dueAt?'确认后到期私聊提醒：'+bjClock(t.dueAt):'没有可确认的未来时间，不设置提醒')),
        '核对文字和时间后，10分钟内发[确认截图待办]['+id+'][确认]；不确认不会保存。'].join('\n'));
    } else if(c==='确认截图待办') {
      if(a.length!==2||a[1]!=='确认')throw Error('须使用完整预览ID和[确认]');
      const p=previews.get(a[0]);if(!p||p.actor!==key)throw Error('预览已失效或不属于你在本会话的预览');
      d.store.editProfile(ctx.userId,v=>{if(v.todos.length+p.tasks.length>200)throw Error('本人待办已满');for(const t of p.tasks)v.todos.push({...t,id:utilityId('t'),createdAt:now(),done:false});});
      previews.delete(a[0]);await d.say(ctx,'已保存'+p.tasks.length+'项到你本人的独立待办，可发[我的待办]查看；未修改原提醒任务。');
    } else if(c==='我的待办') {
      await d.say(ctx,'【我的截图待办】\n'+(d.store.profile(ctx.userId).todos.filter(v=>!v.done).slice(0,20).map(v=>v.id+' '+v.text+(v.dueAt?'｜'+bjClock(v.dueAt):'｜未设置提醒')).join('\n')||'暂无未完成截图待办'));
    } else if(c==='完成截图待办'||c==='删除截图待办') {
      if(a.length!==(c==='删除截图待办'?2:1)||c==='删除截图待办'&&a[1]!=='确认')throw Error('使用完整t_ID；删除需末尾[确认]');
      d.store.editProfile(ctx.userId,p=>{const row=p.todos.find(v=>v.id===a[0]);if(!row)throw Error('没有你本人的此项待办');if(c==='删除截图待办')p.todos=p.todos.filter(v=>v.id!==row.id);else{row.done=true;row.completedAt=now();}});
      await d.say(ctx,'已更新你本人的该项待办。');
    } else if(c==='文件暂存') {
      if(a.length!==1||!a[0]||a[0].length>20)throw Error('引用文件后发[文件暂存][旧版或新版标签]');
      const q=await d.quote(ctx),content=String(await d.readMessage(q));
      if(!content.trim())throw Error('没有提取到可比较的文本');
      if(documents.size>=200&&!documents.has(key+':'+a[0]))throw Error('暂存空间繁忙，请稍后再试');
      documents.set(key+':'+a[0],{at:now(),text:d.redact(content.slice(0,40000))});
      await d.say(ctx,'已暂存“'+a[0]+'”，仅当前会话的你可用，15分钟后过期。'+(content.length>40000?'正文超过40000字符，暂存已截断。':'')+'\n新版同样暂存后发[文件对比][旧版][新版]。');
    } else if(c==='文件对比') {
      if(a.length!==2)throw Error('[文件对比][旧版标签][新版标签]');
      const old=documents.get(key+':'+a[0]),next=documents.get(key+':'+a[1]);
      if(!old||!next)throw Error('旧版或新版未暂存/已过期，请引用文件重新暂存');
      await d.say(ctx,compareDocuments(old.text,next.text));
    } else {
      if(a.length!==1||a[0]!=='确认')throw Error('[清除文件暂存][确认]');
      for(const k of documents.keys())if(k.startsWith(key+':'))documents.delete(k);
      await d.say(ctx,'已清除你在当前会话的文件暂存。');
    }
    return true;
  }
  return {handle};
}
