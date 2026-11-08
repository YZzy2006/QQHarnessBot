import {utilityId} from './utility-store.js';
import {createPracticalStore} from './practical-store.js';
import {digest,tableResult,workbookBuffer,documentEvidence,groundedAnswer,courseEvents,calendarEvents,monitorUrl,feedItems,pageVersion} from './practical-data.js';
import {bjClock} from './life-services.js';

export const PRACTICAL_COMMANDS=['截图转表格','导出表格','文件问答','日历导入','课程表导入','确认日历导入','我的日历','删除日历','我的日历批次','删除日历批次','清理已结束日历','订阅更新','订阅网页','异常监测','我的订阅','取消订阅','恢复订阅'];
export const PRACTICAL_HELP=[
  '引用单张截图：[截图转表格] → 核对预览 → [导出表格][p_ID][确认]',
  '引用文件：[文件问答][问题]；或[文件问答][已暂存标签][问题]，回答附原文行号',
  '引用ICS：[日历导入][提前分钟（默认10）] → [确认日历导入][p_ID][确认]',
  '引用课表截图/文件：[课程表导入][首周周一YYYY-MM-DD][总周数][提前分钟（默认10）]',
  '[我的日历] / [删除日历][z_ID][确认]；通知只发本人白名单私聊',
  '[我的日历批次] / [删除日历批次][b_ID][确认]；[清理已结束日历]先预览，再带p_ID和确认清理',
  '[订阅更新][公开RSS或Atom地址][间隔分钟（默认15）]；首次只建基线，不补发历史',
  '[订阅网页][公开网页地址][间隔分钟（默认15）][关键词（可选）]；比较可提取正文，不运行网页脚本',
  '[异常监测][公开网址][间隔分钟（默认15）]；连续3次失败告警，恢复通知一次',
  '[我的订阅] / [取消订阅][z_ID][确认] / [恢复订阅][z_ID][确认]',
  '默认不自动订阅；检查间隔至少5分钟；回执不明暂停重发，恢复会放弃旧待发通知'
].join('\n');

export function createPracticalTools(d,{attachments}={}) {
  const store=createPracticalStore(d),now=d.now||Date.now,previews=new Map(),documents=new Map(),costs=new Map();
  const actor=ctx=>JSON.stringify([ctx.sourceKey,String(ctx.userId)]),enabled=()=>d.isEnabled?.()!==false;
  const allowed=ctx=>enabled()&&d.isAllowed(ctx.sourceKey);
  const privateKey=ctx=>'private:'+ctx.userId;
  let expensiveActive=0,ticking=false;
  function prune(){for(const map of [previews,documents,costs])for(const [key,v] of map)if(now()-v.at>900000)map.delete(key);}
  const preview=(ctx,type,data)=>{
    prune();if(previews.size>=200)throw Error('待确认预览已满，请稍后重试');
    const id=utilityId('p');previews.set(id,{actor:actor(ctx),type,data,at:now(),state:'ready'});return id;
  };
  function getPreview(ctx,id,type){
    const row=previews.get(id);
    if(!row||row.actor!==actor(ctx)||row.type!==type||now()-row.at>600000)throw Error('预览已过期或不属于你在本会话的请求');
    if(row.state!=='ready')throw Error('本次请求已处理或回执不明，不自动重复提交');return row;
  }
  async function expensive(ctx,kind,fn){
    if(!allowed(ctx))throw Error('请求执行期间权限已变化');
    prune();const key=actor(ctx)+kind,last=costs.get(key);
    if(expensiveActive>=4||costs.size>=400&&!last||last&&now()-last.at<15000)throw Error('识别/问答请求过于频繁，请15秒后再试');
    costs.set(key,{at:now()});expensiveActive++;
    try{const result=await fn();if(!allowed(ctx))throw Error('请求执行期间权限已变化');return result;}finally{expensiveActive--;}
  }
  function redactedEvents(events){return events.map(e=>({...e,title:d.redact(e.title),location:d.redact(e.location)}));}
  const leadTime=raw=>{const n=raw===undefined?10:Number(raw);if(!Number.isInteger(n)||n<0||n>1440)throw Error('提前提醒分钟须为0~1440');return n;};
  const interval=raw=>{const n=raw===undefined?15:Number(raw);if(!Number.isInteger(n)||n<5||n>1440)throw Error('检查间隔须为5~1440分钟');return n*60000;};
  // Old records gave even short meetings a one-hour grace period; honor their explicit end too.
  const eventUntil=e=>Math.min(e.until,e.end>e.at?e.end:e.at+3600000);
  async function privateSay(ctx,text){
    if(!d.isAllowed(privateKey(ctx)))throw Error('本人私聊不在白名单，私人清单不在群内展示');
    await d.say({...ctx,sourceKey:privateKey(ctx)},text);
    if(ctx.sourceKey.startsWith('group:'))await d.say(ctx,'详情已私聊本人。');
  }
  async function previewCalendar(ctx,events,lead){
    if(!allowed(ctx))throw Error('请求执行期间权限已变化');
    if(!d.isAllowed(privateKey(ctx)))throw Error('本人私聊不在白名单，不能导入私人日历提醒');
    const data=redactedEvents(events).filter(e=>e.at>now());
    if(!data.length)throw Error('没有可导入的未来事项；ICS仅预览未来180天，不导入过去事项');
    const fingerprints=new Set(store.read().events.filter(e=>e.owner===String(ctx.userId)).map(e=>e.fingerprint));
    const unique=new Map();for(const e of data){const hash=digest(JSON.stringify([e.uid,e.at]));if(!fingerprints.has(hash))unique.set(hash,{...e,fingerprint:hash});}
    if(!unique.size)throw Error('这些事项已全部导入，不重复创建');
    const id=preview(ctx,'calendar',{events:[...unique.values()],lead});
    await d.say(ctx,'【日历导入预览】'+id+'\n本次新增'+unique.size+'项，已存在或本批重复'+(data.length-unique.size)+'项。时间按北京时间显示；全天事项于当天09:00提醒。\n'+[...unique.values()].slice(0,12).map(e=>bjClock(e.at)+' '+e.title+(e.location?'｜'+e.location:'')).join('\n')+'\n提前'+lead+'分钟，通知仅发本人私聊。超过12项仅展示前12项，可导入后用[我的日历]分页查看。核对后10分钟内发[确认日历导入]['+id+'][确认]；不确认不保存。');
  }
  async function handle(ctx,cmd){
    const c=cmd?.command,a=cmd?.args||[];if(!PRACTICAL_COMMANDS.includes(c))return false;
    if(!allowed(ctx))throw Error('当前功能或会话权限已关闭');prune();
    if(c==='截图转表格'){
      if(a.length)throw Error('引用一张截图后发[截图转表格]');
      const q=await d.quote(ctx);
      const raw=await expensive(ctx,'table',()=>d.extractStructured(q,'table',()=>allowed(ctx)));
      const table=tableResult(raw,d.redact),id=preview(ctx,'table',table);
      await d.say(ctx,'【截图表格预览】'+id+'\n'+table.columns.join(' | ')+'\n'+table.rows.slice(0,10).map(r=>r.map(v=>v.slice(0,60)).join(' | ')).join('\n')+'\n共'+table.rows.length+'行、'+table.columns.length+'列，仅展示前10行；[待核对]标记可能识别不清的单元格。请先核对，10分钟内发[导出表格]['+id+'][确认]。Excel只包含文本，不执行截图中的公式或链接。');
    }else if(c==='导出表格'){
      if(a.length!==2||a[1]!=='确认')throw Error('[导出表格][p_完整ID][确认]');
      const p=getPreview(ctx,a[0],'table');if(!d.sendFile)throw Error('当前网关未配置文件发送能力');
      const bytes=workbookBuffer(p.data);p.state='sending';
      try{
        const sent=await d.sendFile(ctx.sourceKey,{name:'截图表格-'+a[0]+'.xlsx',buffer:bytes},()=>allowed(ctx)&&previews.get(a[0])===p&&now()-p.at<=600000);
        if(sent===false)throw Error('文件提交回执不明');
      }catch{p.state='unknown';throw Error('文件未确认送达，本次不自动重发；请检查QQ客户端，需要时重新识别并确认');}
      previews.delete(a[0]);await d.say(ctx,'Excel文件已提交；客户端显示和下载仍需实际确认。');
    }else if(c==='文件问答'){
      if(a.length<1||a.length>2)throw Error('引用文件后[文件问答][问题]，或[文件问答][暂存标签][问题]');
      const key=actor(ctx);let doc;
      if(a.length===2){doc=attachments?.document(ctx,a[0]);if(!doc)throw Error('该标签没有你在当前会话的有效文件暂存');}
      else if(ctx.quotedId){
        const q=await d.quote(ctx),raw=String(await d.readMessage(q));
        if(!allowed(ctx))throw Error('请求执行期间权限已变化');
        if(!raw.trim())throw Error('没有读取到文件文本；扫描PDF需先OCR');
        if(documents.size>=100&&!documents.has(key))throw Error('文件问答缓存繁忙，请稍后重试');
        doc={text:d.redact(raw.slice(0,40000)),sourceId:String(ctx.quotedId),partial:raw.length>40000||/截断|只提取|超过.*字符/.test(raw),at:now()};documents.set(key,doc);
      }else doc=documents.get(key);
      if(!doc||doc.at!=null&&now()-doc.at>900000)throw Error('先引用文件或使用你本会话暂存的文件标签；缓存15分钟过期');
      const question=d.redact(a.at(-1)),evidence=documentEvidence(doc.text,question);
      const answer=await expensive(ctx,'qa',()=>d.compose('fileQA',evidence));
      await d.say(ctx,'【文件问答】来源消息：'+(doc.sourceId||'当前暂存')+'\n'+groundedAnswer(answer,evidence)+'\n\n覆盖范围：本次纳入'+new Set(evidence.lines.map(v=>v.line)).size+'/'+evidence.totalLines+'个原文行、'+evidence.lines.length+'个片段'+(evidence.partial||doc.partial?'，有筛选或截断，不代表全文问答。':'，为当前已提取文本；不保证包含图片或原文件全部内容。'));
    }else if(c==='日历导入'){
      if(a.length>1)throw Error('引用ICS文件后发[日历导入][提前分钟（可选）]');
      const q=await d.quote(ctx),text=String(await d.readMessage(q));
      await previewCalendar(ctx,calendarEvents(text,now()),leadTime(a[0]));
    }else if(c==='课程表导入'){
      if(a.length<2||a.length>3)throw Error('[课程表导入][首周周一YYYY-MM-DD][总周数][提前分钟（可选）]');
      const q=await d.quote(ctx),hasImage=q.message.some(v=>v.type==='image');
      const raw=await expensive(ctx,'courses',async()=>{
        if(hasImage)return d.extractStructured(q,'courses',()=>allowed(ctx));
        const text=d.redact(String(await d.readMessage(q)).slice(0,16000));
        if(!allowed(ctx))throw Error('请求执行期间权限已变化');
        return d.compose('courseExtract',{text,totalWeeks:Number(a[1])});
      });
      await previewCalendar(ctx,courseEvents(raw,a[0],Number(a[1])),leadTime(a[2]));
    }else if(c==='确认日历导入'){
      if(a.length!==2||a[1]!=='确认')throw Error('[确认日历导入][p_完整ID][确认]');
      const p=getPreview(ctx,a[0],'calendar');if(!d.isAllowed(privateKey(ctx)))throw Error('本人私聊权限已变化');
      let count=0;const batchId=utilityId('b');
      store.change(s=>{
        const own=s.events.filter(e=>e.owner===String(ctx.userId));
        const existing=new Set(own.map(e=>e.fingerprint)),fresh=p.data.events.filter(e=>e.at>now()&&!existing.has(e.fingerprint));
        if(own.length+fresh.length>200||s.events.length+fresh.length>1000)throw Error('日历容量已满，请先清理已结束事项');
        for(const e of fresh){s.events.push({...e,id:utilityId('z'),batchId,owner:String(ctx.userId),createdAt:now(),notifyAt:Math.max(now(),e.at-(e.allDay?0:p.data.lead)*60000),until:e.end>e.at?e.end:e.at+3600000});count++;}
      });previews.delete(a[0]);await d.say(ctx,'已导入'+count+'项到本人独立日历提醒；批次：'+batchId+'。重复、过期项已跳过，未修改原提醒任务。');
    }else if(c==='我的日历'){
      if(a.length>1||a[0]!=null&&!/^[1-9]\d?$/.test(a[0]))throw Error('[我的日历][页码（可选）]');
      const rows=store.read().events.filter(e=>e.owner===String(ctx.userId)).sort((x,y)=>x.at-y.at),page=Number(a[0]||1);
      await privateSay(ctx,'【我的日历】共'+rows.length+'项，第'+page+'页\n'+(rows.slice((page-1)*20,page*20).map(e=>e.id+' '+bjClock(e.at)+' '+e.title+(e.location?'｜'+e.location:'')+(e.delivery?'｜'+({sent:'已提醒',sending:'提醒回执待核对',unknown:'提醒回执不明，不自动重发',expired:'过期未提醒'}[e.delivery]):'')).join('\n')||'本页没有事项'));
    }else if(c==='我的日历批次'){
      if(a.length)throw Error('[我的日历批次]无需参数');
      const batches=new Map();let legacy=0;
      for(const e of store.read().events.filter(e=>e.owner===String(ctx.userId))){
        if(!e.batchId){legacy++;continue;}
        const b=batches.get(e.batchId)||{count:0,ended:0,at:e.createdAt};b.count++;if(now()>eventUntil(e))b.ended++;batches.set(e.batchId,b);
      }
      await privateSay(ctx,'【我的日历批次】\n'+([...batches].map(([id,b])=>id+' '+bjClock(b.at)+'｜'+b.count+'项，已结束'+b.ended+'项').join('\n')||'暂无带批次的事项')+(legacy?'\n另有'+legacy+'项旧记录无批次，可逐项删除或清理已结束事项。':'')+'\n删除整批：[删除日历批次][b_完整ID][确认]');
    }else if(c==='删除日历批次'){
      if(a.length!==2||a[1]!=='确认'||!/^b_[a-f0-9]{12}$/.test(a[0]))throw Error('[删除日历批次][b_完整ID][确认]');
      let count=0;store.change(s=>{const rows=s.events.filter(e=>e.owner===String(ctx.userId)&&e.batchId===a[0]);if(!rows.length)throw Error('没有你本人的此日历批次');count=rows.length;s.events=s.events.filter(e=>!rows.includes(e));});
      await d.say(ctx,'已删除本人此批次'+count+'项独立日历，不影响其他批次或原任务。');
    }else if(c==='清理已结束日历'){
      if(!a.length){
        const rows=store.read().events.filter(e=>e.owner===String(ctx.userId)&&now()>eventUntil(e));
        if(!rows.length){await d.say(ctx,'本人没有可清理的已结束日历。');return true;}
        const id=preview(ctx,'calendarCleanup',{ids:rows.map(e=>e.id)});
        await d.say(ctx,'【已结束日历清理预览】'+id+'\n仅清理本人已结束的'+rows.length+'项独立日历，保留未来事项及原任务。核对后10分钟内发[清理已结束日历]['+id+'][确认]。');
      }else{
        if(a.length!==2||a[1]!=='确认')throw Error('先[清理已结束日历]预览，再[清理已结束日历][p_完整ID][确认]');
        const p=getPreview(ctx,a[0],'calendarCleanup'),ids=new Set(p.data.ids);let count=0;
        store.change(s=>{s.events=s.events.filter(e=>{const remove=e.owner===String(ctx.userId)&&ids.has(e.id)&&now()>eventUntil(e);if(remove)count++;return !remove;});});
        previews.delete(a[0]);await d.say(ctx,'已清理本人预览范围内'+count+'项已结束独立日历。');
      }
    }else if(c==='删除日历'){
      if(a.length!==2||a[1]!=='确认')throw Error('[删除日历][z_完整ID][确认]');
      store.change(s=>{const row=s.events.find(e=>e.id===a[0]&&e.owner===String(ctx.userId));if(!row)throw Error('没有你本人的此日历ID');s.events=s.events.filter(e=>e!==row);});await d.say(ctx,'已删除本人此项独立日历，不影响原任务。');
    }else if(c==='订阅更新'||c==='订阅网页'||c==='异常监测'){
      if(a.length<1||a.length>(c==='订阅网页'?3:2))throw Error('填写公开URL、可选检查间隔，网页模式可再填写关键词');
      if(!d.isAllowed(privateKey(ctx)))throw Error('本人私聊不在白名单，不能订阅通知');
      const url=monitorUrl(a[0]);if(url.length>1000||d.redact(url)!==url)throw Error('订阅地址过长或包含敏感信息');
      const kind=c==='订阅更新'?'feed':c==='订阅网页'?'page':'health',ms=interval(a[1]),keyword=String(a[2]||'').trim();
      if(keyword.length>50||d.redact(keyword)!==keyword)throw Error('关键词须为50字以内且不能含敏感信息');
      await d.validateUrl(url);
      if(!allowed(ctx))throw Error('请求执行期间权限已变化');
      let baseline=[],health='unknown',excerpt='',lastError='';
      try{
        const response=await d.fetchPublic(url,200000);
        if(response.statusCode<200||response.statusCode>=300||kind!=='health'&&response.truncated)throw Error('请求未取得完整成功响应');
        const page=kind==='page'?pageVersion(response.body,keyword):null;
        baseline=kind==='feed'?feedItems(response.body,response.url||url).map(v=>v.id):page?[page.id]:[];excerpt=page?d.redact(page.excerpt).slice(0,240):'';health='up';
      }catch{lastError='首次检查未取得有效响应';if(kind!=='health')throw Error('无法读取完整订阅内容、格式不符或关键词未找到，尚未订阅；普通网页请用[订阅网页]');}
      if(!allowed(ctx)||!d.isAllowed(privateKey(ctx)))throw Error('请求执行期间权限已变化');
      const id=utilityId('z');
      store.change(s=>{
        if(s.watches.some(w=>w.owner===String(ctx.userId)&&w.kind===kind&&w.url===url))throw Error('你已订阅此地址，请勿重复创建');
        if(s.watches.length>=64||s.watches.filter(w=>w.owner===String(ctx.userId)).length>=10)throw Error('订阅容量已满（每人10项，全局64项）');
        s.watches.push({id,owner:String(ctx.userId),createdAt:now(),kind,url,interval:ms,nextAt:now()+ms,lastCheckedAt:now(),lastError,failures:0,health,seen:baseline,initialized:kind!=='health',...(kind==='page'?{keyword,excerpt}:{})});
      });await privateSay(ctx,'已创建'+({feed:'更新订阅',page:'网页订阅',health:'异常监测'}[kind])+' '+id+'\n'+url+'\n每'+ms/60000+'分钟检查；首次不补发历史，异常连续3次才通知。通知只发本人，服从安静时段、暂停和限额。');
    }else if(c==='我的订阅'){
      if(a.length)throw Error('[我的订阅]无需参数');
      await privateSay(ctx,'【我的订阅】\n'+(store.read().watches.filter(w=>w.owner===String(ctx.userId)).map(w=>w.id+' '+({feed:'RSS/Atom',page:'网页正文',health:'异常监测'}[w.kind])+' '+w.url+'\n间隔'+w.interval/60000+'分钟；连续失败'+w.failures+'次\n上次检查：'+(w.lastCheckedAt!=null?bjClock(w.lastCheckedAt):'旧记录暂无')+'；下次检查：'+(w.pending?'待当前通知处理后继续':bjClock(w.nextAt))+'\n最近失败原因：'+(w.lastError||'无')+'\n通知状态：'+(w.pending?.state==='unknown'||w.pending?.state==='sending'?'回执不明，需核对后显式恢复':w.pending?quiet(w.owner)?'等待免打扰时段结束':!d.canNotify('private:'+w.owner)?'等待发送条件或限额恢复':'等待发送':'暂无待发通知')).join('\n\n')||'尚无订阅'));
    }else if(c==='取消订阅'||c==='恢复订阅'){
      if(a.length!==2||a[1]!=='确认')throw Error('须使用完整z_ID并在末尾[确认]');
      store.change(s=>{const w=s.watches.find(w=>w.id===a[0]&&w.owner===String(ctx.userId));if(!w)throw Error('没有你本人的此订阅ID');if(c==='取消订阅')s.watches=s.watches.filter(x=>x!==w);else{delete w.pending;w.nextAt=now()+w.interval;}});
      await d.say(ctx,c==='取消订阅'?'已取消此订阅；在途检查结果不会恢复它。':'已恢复后续通知，旧待发通知已放弃，不自动重放。');
    }
    return true;
  }

  function quiet(uid){const p=d.store.profile(uid),h=new Date(now()+28800000).getUTCHours();return p.quietStart<p.quietEnd?h>=p.quietStart&&h<p.quietEnd:h>=p.quietStart||h<p.quietEnd;}
  const canNotify=uid=>enabled()&&d.isAllowed('private:'+uid)&&!quiet(uid)&&d.canNotify('private:'+uid);
  async function deliverWatch(id){
    const w=store.read().watches.find(v=>v.id===id);if(!w?.pending||w.pending.state!=='ready'||!canNotify(w.owner))return;
    const notice=w.pending;
    store.change(s=>{const row=s.watches.find(v=>v.id===id);if(row?.pending?.id===notice.id)row.pending.state='sending';});
    const current=store.read().watches.find(v=>v.id===id);
    if(current?.pending?.id!==notice.id||!canNotify(w.owner)){
      store.change(s=>{const row=s.watches.find(v=>v.id===id);if(row?.pending?.id===notice.id)row.pending.state='ready';});return;
    }
    const authorize=()=>canNotify(w.owner)&&store.read().watches.some(v=>v.id===id&&v.pending?.id===notice.id&&v.pending.state==='sending');
    let sent=false;try{sent=await d.send('private:'+w.owner,d.redact(notice.text),{manual:false,noMemory:true,authorize})!==false;}catch{}
    if(!store.read().watches.some(v=>v.id===id&&v.pending?.id===notice.id))return;
    store.change(s=>{const row=s.watches.find(v=>v.id===id);if(row?.pending?.id===notice.id){if(sent)delete row.pending;else row.pending.state='unknown';}});
  }
  async function checkWatch(w){
    let response,items=[],up=false,lastError='请求失败（网络、DNS或安全校验）';
    try{
      response=await d.fetchPublic(w.url,w.kind==='health'?1024:200000);
      up=response.statusCode>=200&&response.statusCode<300&&(w.kind==='health'||!response.truncated);
      lastError=!Number.isInteger(response.statusCode)?'响应缺少有效HTTP状态':response.statusCode<200||response.statusCode>=300?'HTTP '+response.statusCode:response.truncated&&w.kind!=='health'?'响应正文被截断':'';
      if(up){lastError='内容格式不符或未找到关键词';if(w.kind==='feed')items=feedItems(response.body,response.url||w.url);else if(w.kind==='page')items=[pageVersion(response.body,w.keyword)];lastError='';}
    }catch{up=false;}
    if(!enabled()||!d.isAllowed('private:'+w.owner))return;
    store.change(s=>{
      const row=s.watches.find(v=>v.id===w.id);if(!row||row.nextAt!==w.nextAt||row.pending)return;
      row.nextAt=now()+row.interval;row.lastCheckedAt=now();row.lastError=lastError;let text='';
      if(up){
        if(row.health==='down')text='【监测恢复】'+row.id+'\n'+row.url+'\n当前检查已恢复正常。';
        row.failures=0;row.health='up';
        if(row.kind==='feed'){
          const fresh=items.filter(v=>!row.seen.includes(v.id));
          // Preserve pending updates as a durable outbox before advancing the seen baseline.
          if(row.initialized&&fresh.length)text='【订阅更新】'+row.id+'\n'+fresh.slice(0,5).map(v=>v.title+(v.url?'\n'+v.url:'')).join('\n\n')+(fresh.length>5?'\n另有'+(fresh.length-5)+'条更新，本次合并通知。':'');
          row.seen=[...new Set([...items.map(v=>v.id),...row.seen])].slice(0,500);row.initialized=true;
        }else if(row.kind==='page'){
          if(row.seen[0]!==items[0].id)text='【网页更新】'+row.id+'\n'+row.url+'\n可提取正文发生变化'+(row.keyword?'（关键词附近片段）':'')+'。\n之前片段：\n'+(row.excerpt||'旧记录未保存片段')+'\n当前片段：\n'+items[0].excerpt;
          row.seen=[items[0].id];row.excerpt=d.redact(items[0].excerpt).slice(0,240);
        }
      }else{row.failures=Math.min(9999,row.failures+1);if(row.failures>=3&&row.health!=='down'){row.health='down';text='【连续异常】'+row.id+'\n'+row.url+'\n已连续'+row.failures+'次未获得有效响应；这只是本机探测结果，不代表所有用户均不可访问。';}}
      if(text)row.pending={id:digest(row.id+text),text:d.redact(text).slice(0,4000),state:'ready'};
    });await deliverWatch(w.id);
  }
  async function tick(){
    if(ticking||!enabled())return;ticking=true;
    try{
      if(store.read().events.some(e=>!e.delivery&&now()>eventUntil(e)))store.change(s=>{for(const e of s.events)if(!e.delivery&&now()>eventUntil(e))e.delivery='expired';});
      for(const event of store.read().events.filter(e=>!e.delivery&&e.notifyAt<=now()&&canNotify(e.owner)).sort((a,b)=>a.notifyAt-b.notifyAt).slice(0,5)){
        if(!canNotify(event.owner))continue;
        store.change(s=>{const e=s.events.find(v=>v.id===event.id);if(e&&!e.delivery)e.delivery=now()>eventUntil(e)?'expired':'sending';});
        const live=store.read().events.find(v=>v.id===event.id);
        if(live?.delivery!=='sending')continue;
        let sent=false;
        const authorize=()=>canNotify(live.owner)&&now()<=eventUntil(live)&&store.read().events.some(v=>v.id===live.id&&v.delivery==='sending');
        try{if(authorize())sent=await d.send('private:'+live.owner,d.redact('【日历提醒】'+live.title+'\n'+bjClock(live.at)+(live.location?'\n地点：'+live.location:'')),{manual:false,noMemory:true,authorize})!==false;}catch{}
        store.change(s=>{const e=s.events.find(v=>v.id===live.id);if(e?.delivery==='sending')e.delivery=sent?'sent':'unknown';});
      }
      const pending=store.read().watches.filter(w=>w.pending?.state==='ready'&&canNotify(w.owner));for(const w of pending.slice(0,2))await deliverWatch(w.id);
      const due=store.read().watches.filter(w=>!w.pending&&w.nextAt<=now()&&d.isAllowed('private:'+w.owner)).sort((a,b)=>a.nextAt-b.nextAt).slice(0,2);
      for(const w of due){if(!enabled())break;await checkWatch(w);}
    }catch{d.audit?.('[practical] 调度或存储检查失败，已停止本次检查');}finally{ticking=false;}
  }
  return {handle,tick,store};
}
