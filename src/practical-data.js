// 受限数据转换：模型只提供候选结构，日期、引用和表格均由程序校验。
import crypto from 'node:crypto';
import XLSX from 'xlsx';
import ICAL from 'ical.js';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {isPrivateIp} from './safe-fetch.js';
import {isIP} from 'node:net';

export const digest=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
export function jsonResult(raw) {
  const text=String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g,'');
  if(text.length>24000)throw Error('结构化结果过长，请缩小输入范围');
  try{return JSON.parse(text);}catch{throw Error('没有返回完整可核验的JSON，请换清晰输入重试');}
}
export function tableResult(raw,redact=String) {
  const data=typeof raw==='string'?jsonResult(raw):raw;
  if(!data||!Array.isArray(data.columns)||data.columns.length<1||data.columns.length>16||!Array.isArray(data.rows)||!data.rows.length||data.rows.length>100)throw Error('表格须有1~16列、1~100行，请裁剪过大的截图');
  const clean=v=>{if(typeof v!=='string'||v.length>500)throw Error('表格单元格必须是500字以内的原始文字');return redact(v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,''));};
  const columns=data.columns.map(clean);
  if(columns.some(v=>!v.trim())||new Set(columns).size!==columns.length)throw Error('请提供非空且不重复的列名');
  const rows=data.rows.map(row=>{if(!Array.isArray(row)||row.length!==columns.length)throw Error('表格列数不一致，未导出');return row.map(v=>v===null?'[待核对]':clean(v));});
  if(JSON.stringify({columns,rows}).length>20000)throw Error('表格内容超过20000字符，请分段识别');
  const uncertain=(data.uncertain||[]);
  if(!Array.isArray(uncertain)||uncertain.length>100||uncertain.some(v=>!Number.isInteger(v.row)||v.row<1||v.row>rows.length||!Number.isInteger(v.column)||v.column<1||v.column>columns.length))throw Error('表格待核对坐标无效');
  for(const cell of uncertain){const row=rows[cell.row-1];row[cell.column-1]='[待核对] '+row[cell.column-1];}
  return {columns,rows};
}
export function workbookBuffer(table) {
  const sheet=XLSX.utils.aoa_to_sheet([table.columns,...table.rows].map(row=>row.map(v=>({t:'s',v:String(v)}))));
  sheet['!cols']=table.columns.map(()=>({wch:24}));
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'截图表格');
  return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true});
}
export function documentEvidence(text,question) {
  const lines=String(text).replace(/\r\n?/g,'\n').split('\n');
  if(!String(question).trim()||question.length>500)throw Error('问题须为1~500字');
  const chunks=[];
  for(const [i,line] of lines.entries()){
    if(line.length<=2000){chunks.push({line:i+1,text:line});continue;}
    for(let start=0;start<line.length;){
      let end=Math.min(line.length,start+1200);
      if(end<line.length){
        const window=line.slice(start,end),matches=[...window.matchAll(/[。！？；.!?;]\s*/g)],last=matches.at(-1);
        if(last&&last.index>=600)end=start+last.index+last[0].length;
        else if(/[\uD800-\uDBFF]/.test(line[end-1]))end--;
      }
      chunks.push({line:i+1,text:line.slice(start,end),columnStart:start+1,columnEnd:end,lineLength:line.length});start=end;
    }
  }
  const tokens=[...new Set((question.match(/[A-Za-z0-9_]{2,}|[\u4e00-\u9fff]{2}/g)||[]).map(v=>v.toLowerCase()))];
  const ranked=chunks.map((v,i)=>({i,score:tokens.reduce((n,t)=>n+(v.text.toLowerCase().includes(t)?1:0),0)})).filter(v=>v.score).sort((a,b)=>b.score-a.score||a.i-b.i);
  const indices=new Set();
  if(ranked.length){for(const r of ranked.slice(0,30))for(let i=Math.max(0,r.i-2);i<=Math.min(chunks.length-1,r.i+3);i++)indices.add(i);}
  else for(let i=0;i<Math.min(chunks.length,300);i++)indices.add(i);
  const selected=[];let chars=0;
  for(const i of [...indices].sort((a,b)=>a-b)){
    const row=chunks[i];if(chars+JSON.stringify(row).length>14000)break;
    selected.push(row);chars+=JSON.stringify(row).length;
  }
  if(!selected.length)throw Error('文件没有可纳入的文本，请换可读取的文件或缩小范围');
  return {question,lines:selected,totalLines:lines.length,partial:selected.length<chunks.length};
}
export function groundedAnswer(raw,evidence) {
  const data=jsonResult(raw);
  if(typeof data.answer!=='string'||data.answer.length>2000||!Array.isArray(data.citations)||data.citations.length>5)throw Error('文件问答没有返回可核验的回答与引用');
  if(!data.citations.length)return '本次纳入的文件范围内未找到足够依据，不能据此推断全文没有。';
  const selected=new Map();
  for(const row of evidence.lines){if(!selected.has(row.line))selected.set(row.line,[]);selected.get(row.line).push(row);}
  const citations=data.citations.map(c=>{
    if(!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<1||c.end<c.start||c.end-c.start>8||typeof c.quote!=='string'||!c.quote.trim()||c.quote.length>1500)throw Error('文件引用位置无效，未输出未经核验的回答');
    const passages=[];let passage='',previous;
    for(let n=c.start;n<=c.end;n++){
      if(!selected.has(n))throw Error('回答引用了本次未纳入的行，已拒绝');
      for(const row of [...selected.get(n)].sort((a,b)=>(a.columnStart||1)-(b.columnStart||1))){
        const start=row.columnStart||1,end=row.columnEnd??row.text.length,length=row.lineLength??row.text.length;
        const adjacent=previous&&(previous.line===n&&start===previous.end+1||previous.line+1===n&&previous.end===previous.length&&start===1);
        if(previous&&!adjacent){passages.push(passage);passage='';}
        passage+=(adjacent&&previous.line!==n?'\n':'')+row.text;previous={line:n,end,length};
      }
    }
    passages.push(passage);
    if(!passages.some(v=>v.includes(c.quote)))throw Error('回答引用与原文不符，已拒绝');
    return `第${c.start}~${c.end}行：${c.quote}`;
  });
  return '回答（基于文件归纳）：'+data.answer+'\n\n可核对原文：\n'+citations.join('\n');
}

const parseDay=s=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('日期格式为YYYY-MM-DD');
  const at=Date.parse(s+'T00:00:00+08:00');
  if(!Number.isFinite(at)||new Date(at+28800000).toISOString().slice(0,10)!==s)throw Error('日期无效');return at;
};
const minutes=s=>{if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s))throw Error('时间须明确到HH:mm，不能猜测节次时间');return Number(s.slice(0,2))*60+Number(s.slice(3));};
export function courseEvents(raw,monday,weeks=16) {
  const first=parseDay(monday);
  if(new Date(first+28800000).getUTCDay()!==1||!Number.isInteger(weeks)||weeks<1||weeks>32)throw Error('学期首日须为周一，总周数须为1~32');
  const data=typeof raw==='string'?jsonResult(raw):raw;
  if(!Array.isArray(data?.courses)||!data.courses.length||data.courses.length>40)throw Error('课程表须有1~40条课程规则');
  const events=[];
  for(const row of data.courses){
    if(typeof row.title!=='string'||!row.title.trim()||row.title.length>100||!Number.isInteger(row.weekday)||row.weekday<1||row.weekday>7||!Array.isArray(row.weeks)||!row.weeks.length||row.weeks.length>32||new Set(row.weeks).size!==row.weeks.length||row.weeks.some(v=>!Number.isInteger(v)||v<1||v>weeks)||row.location!=null&&(typeof row.location!=='string'||row.location.length>200))throw Error('课程名称、星期、周次或地点不完整，未导入');
    const start=minutes(row.start),end=minutes(row.end);if(end<=start)throw Error('课程结束时间必须晚于开始时间');
    for(const week of row.weeks){
      const at=first+((week-1)*7+row.weekday-1)*86400000+start*60000;
      events.push({uid:digest(JSON.stringify([row.title,row.weekday,row.start,row.end,row.location||''])),at,end:at+(end-start)*60000,title:row.title,location:row.location||'',allDay:false});
    }
  }
  if(events.length>200)throw Error('课程展开超过200项，请分批或缩短周数');
  return events;
}

export function calendarEvents(text,now=Date.now()) {
  text=String(text).replace(/\r?\n[ \t]/g,'');
  if(text.length>100000||!/^BEGIN:VCALENDAR\r?$/m.test(text)||!/^END:VCALENDAR\r?$/m.test(text))throw Error('请提供完整的ICS日历文件，不能导入截断内容');
  let depth=0,blocks=0;
  for(const line of text.split(/\r?\n/)){
    if(line.startsWith('BEGIN:')){if(++depth>8||++blocks>1000)throw Error('ICS嵌套或组件数量过多');}
    else if(line.startsWith('END:')){if(--depth<0)throw Error('ICS组件未配对');}
    const dt=/^(?:DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)(?:;[^:]*)?:(.*)$/.exec(line);
    if(dt)for(const part of dt[1].split(',')){
      const m=/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(part);
      if(!m)throw Error('ICS日期时间格式不支持');
      const [,y,mo,day,h='00',mi='00',s='00']=m;
      if(new Date(Date.UTC(Number(y),Number(mo)-1,Number(day))).toISOString().slice(0,10)!==`${y}-${mo}-${day}`||Number(h)>23||Number(mi)>59||Number(s)>59)throw Error('ICS包含无效日期时间');
    }
  }
  if(depth!==0)throw Error('ICS组件未配对');
  const root=new ICAL.Component(ICAL.parse(text));
  if(root.getFirstPropertyValue('calscale')&&root.getFirstPropertyValue('calscale')!=='GREGORIAN')throw Error('当前仅支持公历ICS日历');
  const replaced=[];
  const register=(id,zone)=>{replaced.push([id,ICAL.TimezoneService.get(id)]);ICAL.TimezoneService.register(id,zone);};
  try{
    const shanghai=new ICAL.Component(ICAL.parse('BEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE'));
    register('Asia/Shanghai',new ICAL.Timezone({component:shanghai}));
    for(const zone of root.getAllSubcomponents('vtimezone')){const id=zone.getFirstPropertyValue('tzid');if(!id||id==='Asia/Shanghai')continue;register(id,new ICAL.Timezone({component:zone}));}
    const components=root.getAllSubcomponents('vevent');if(!components.length||components.length>200)throw Error('ICS须包含1~200个事件定义');
    const events=[],masters=new Map();
    for(const c of components){
      for(const p of c.getAllProperties()){
        const tz=p.getParameter('tzid');if(tz&&!ICAL.TimezoneService.get(tz))throw Error('日历含未定义时区，请附VTIMEZONE或转换为UTC/Asia/Shanghai');
      }
      const event=new ICAL.Event(c);
      if(!event.uid||event.uid.length>512||!event.startDate)throw Error('日历事件缺少有效UID或开始时间');
      if(!event.isRecurrenceException()){if(masters.has(event.uid))throw Error('ICS包含重复主事件UID');masters.set(event.uid,event);}
    }
    for(const c of components){const e=new ICAL.Event(c);if(e.isRecurrenceException()){if(!masters.has(e.uid))throw Error('ICS例外事件缺少对应主事件');masters.get(e.uid).relateException(e);}}
    const toAt=t=>t.isDate?Date.UTC(t.year,t.month-1,t.day,1):t.zone===ICAL.Timezone.localTimezone?Date.UTC(t.year,t.month-1,t.day,t.hour,t.minute,t.second)-28800000:t.toJSDate().getTime();
    const until=now+180*86400000;
    for(const event of masters.values()){
      if(event.component.getFirstPropertyValue('status')==='CANCELLED')continue;
      const iter=event.iterator();let n=0,next;
      while((next=iter.next())){
        if(++n>10000)throw Error('日历历史重复项过多，请导出近期范围');
        if(toAt(next)>until)break;
        const occurrence=event.getOccurrenceDetails(next),item=occurrence.item;
        if(item.component.getFirstPropertyValue('status')==='CANCELLED')continue;
        const at=toAt(occurrence.startDate),end=toAt(occurrence.endDate);
        if(at<now||at>until)continue;
        const title=String(item.summary||'未命名日历事项'),location=String(item.location||'');
        if(title.length>100||location.length>200||end<at)throw Error('日历标题/地点过长或时间无效');
        events.push({uid:event.uid,at,end,title,location,allDay:occurrence.startDate.isDate});
        if(events.length>200)throw Error('近期日历展开超过200项，请分批导出');
      }
    }
    return events;
  }finally{for(const [id,zone] of replaced.reverse()){ICAL.TimezoneService.remove(id);if(zone)ICAL.TimezoneService.register(id,zone);}}
}

export function monitorUrl(raw) {
  let u;try{u=new URL(raw);}catch{throw Error('请填写完整的公开HTTP/HTTPS地址');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash||u.port&&u.port!=='80'&&u.port!=='443')throw Error('只监测公开HTTP/HTTPS标准端口，不接受凭据或片段');
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||!host.includes('.')&&!isIP(host)||isIP(host)&&isPrivateIp(host))throw Error('不能订阅内网、本机或保留地址');
  if([...u.searchParams.keys()].some(k=>/key|token|secret|pass|auth|signature|credential/i.test(k)))throw Error('订阅地址不能包含访问密钥或签名参数');
  return u.href;
}
export function feedItems(xml,base) {
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||xml.length>200000||XMLValidator.validate(xml)!==true)throw Error('订阅内容不是安全完整的RSS/Atom XML');
  const p=new XMLParser({ignoreAttributes:false,processEntities:false,parseTagValue:false,trimValues:true,removeNSPrefix:true}).parse(xml);
  const raw=p.rss?.channel?.item??p.feed?.entry;
  if(raw==null&&!p.rss?.channel&&!p.feed)throw Error('地址不是RSS/Atom订阅源');
  const rows=raw==null?[]:Array.isArray(raw)?raw:[raw];if(rows.length>500)throw Error('订阅源条目过多');
  const value=v=>typeof v==='string'?v:typeof v?.['#text']==='string'?v['#text']:'';
  return rows.slice(0,200).map(item=>{
    const links=Array.isArray(item.link)?item.link:[item.link];const link=links.find(v=>typeof v==='string'||v?.['@_rel']==='alternate')||links[0];
    const rawLink=typeof link==='string'?link:link?.['@_href'];let url='';
    try{if(rawLink)url=monitorUrl(new URL(rawLink,base).href);}catch{}
    const title=value(item.title).replace(/<[^>]*>/g,'').slice(0,200)||'未命名更新';
    const identity=value(item.guid)||value(item.id)||url||title;
    return {id:digest(identity),title,url};
  });
}
export function pageVersion(html,keyword='') {
  const text=String(html).replace(/<!--[\s\S]*?-->/g,' ').replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
  if(!text)throw Error('页面没有可提取正文，请使用RSS/Atom或静态页面');
  let content=text;
  if(keyword){const at=text.indexOf(keyword);if(at<0)throw Error('页面未找到指定关键词');content=text.slice(Math.max(0,at-200),at+800);}
  return {id:digest(content),excerpt:content.slice(0,240)};
}
