import crypto from 'node:crypto';
const bad=message=>{throw Object.assign(Error(message),{statusCode:400});};
export const recordRevision=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function recordTime(value) {
  if(typeof value==='number')return Number.isFinite(value)?value:0;
  if(typeof value!=='string'||!value)return 0;
  // Old activity files only contain a clock, never invent a day for them.
  if(/^\d{2}:\d{2}:\d{2}$/.test(value))return 0;
  const at=Date.parse(value);return Number.isFinite(at)?at:0;
}
export function pageRecords(rows,params=new URLSearchParams(),{now=Date.now(),limit=12}={}) {
  const get=name=>String(params.get(name)||'').trim();
  const from=get('from'),to=get('to'),q=get('q').toLocaleLowerCase(),kind=get('kind'),state=get('state');
  const date=v=>!v||(/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v);
  if(!date(from)||!date(to)||from&&to&&from>to)bad('请选择有效的起止日期');
  if(q.length>120||kind.length>40||state.length>40)bad('筛选条件过长');
  const size=get('size')?Number(get('size')):limit,page=get('page')?Number(get('page')):1;
  if(![6,12,24].includes(size)||!Number.isSafeInteger(page)||page<1||page>100000)bad('分页参数无效');
  const start=from?Date.parse(from+'T00:00:00+08:00'):0,end=to?Date.parse(to+'T00:00:00+08:00')+86400000:Infinity;
  const filtered=rows.filter(r=>{
    const at=recordTime(r.at??r.time??r.createdAt);
    return (!from&&!to||at>0&&at>=start&&at<end)&&(!kind||kind==='all'||r.kind===kind)&&(!state||state==='all'||(r.decision?.status||r.status)===state)&&(!q||JSON.stringify(r).toLocaleLowerCase().includes(q));
  }).sort((a,b)=>recordTime(b.at??b.time??b.createdAt)-recordTime(a.at??a.time??a.createdAt)||String(a.id||'').localeCompare(String(b.id||'')));
  const total=filtered.length,pages=Math.max(1,Math.ceil(total/size)),current=Math.min(page,pages);
  return {items:filtered.slice((current-1)*size,current*size),total,page:current,pages,size,undated:filtered.filter(r=>!recordTime(r.at??r.time??r.createdAt)).length,retained:rows.length,at:now};
}
export function activityRecord(line,{at=0,redact=String}={}) {
  let body=String(line||'').trim(),clock='';const stamp=/^\[([^\]]+)\]\s*/.exec(body);
  if(stamp){clock=stamp[1];at=recordTime(clock)||at;body=body.slice(stamp[0].length);}
  const match=/^((?:private|group):\d+)\s*(?:\[([^\]]+)\]\s*)?([\s\S]*)$/.exec(body);
  let key=match?.[1]||'',source=match?.[2]||'',message=match?.[3]||body,kind='',title='';
  if(/AI 内部输出[:：]/.test(message)){kind='reflection';title='樱良的独白';message=message.replace(/^.*?AI 内部输出[:：]\s*/,'');}
  else if(/\[(?:QQ空间|Qzone|qzone)\]|^QQ空间|说说(?:发布|已发)|发布.*说说/i.test(body)){kind='qzone';title='QQ 空间动态';}
  else if(/agent 回复[:：]|发送(?:语音|表情)|拍一拍事件|工具拍一拍/.test(message)){kind=key.startsWith('group:')?'group':'private';title=kind==='group'?'群聊互动':'私聊互动';message=message.replace(/^agent 回复[:：]\s*/,'').replace(/^工具(?:分条|统一)发送[:：]/,'消息已发送：');}
  else if(['schedule','reminder','proactive'].includes(source)){kind='arrangement';title=source==='proactive'?'主动问候安排':'提醒与安排';}
  else if(/AI 反馈/.test(message)){kind='feedback';title='她留下的反馈';}
  else return null;
  message=redact(message).replace(/\[?reserved2\]?/g,'').trim().slice(0,2000);
  if(!message)return null;
  return {id:recordRevision({at,clock,key,kind,message}).slice(0,24),at,clock,key,kind,title,text:message,notSent:kind==='reflection'};
}
export function memoryRecords(data) {
  const rows=[];
  for(const row of data.notes||[])rows.push({...row,kind:'note',at:row.createdAt||row.at||row.updatedAt||0,revision:recordRevision(row)});
  for(const row of data.todos||[])rows.push({...row,kind:'todo',at:row.createdAt||row.at||row.updatedAt||0,revision:recordRevision(row)});
  for(const row of data.tasks||[])rows.push({...row,kind:'task',revision:recordRevision(row)});
  for(const row of data.memories||[])rows.push({...row,kind:'saved',at:row.createdAt,revision:recordRevision(row)});
  for(const c of data.conversations||[]){
    for(const [category,name]of [['activeTopics','activeTopic'],['pendingThoughts','pendingThought']])for(const r of c.raw?.[category]||[])rows.push({...r,kind:'conversation',category:name,key:c.key,at:r.createdAt||r.at||r.lastAt||0,revision:recordRevision(r)});
    for(const [target,r]of Object.entries(c.raw?.memberImpressions||{}))rows.push({...r,kind:'conversation',category:'memberImpression',target,key:c.key,text:(r.traits||[]).join('，'),at:r.lastSeenAt||0,revision:recordRevision(r)});
  }
  return rows;
}
