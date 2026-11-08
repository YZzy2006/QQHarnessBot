import {test} from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import {tableResult,workbookBuffer,documentEvidence,groundedAnswer,courseEvents,calendarEvents,monitorUrl,feedItems} from '../src/practical-data.js';

test('截图表格保留前导零、标记不清楚单元格，公式只作为文本',()=>{
  const data=tableResult({columns:['编号','内容'],rows:[['001','=HYPERLINK("https://example.com")'],['002',null]],uncertain:[{row:2,column:2}]});
  const wb=XLSX.read(workbookBuffer(data),{type:'buffer'}),sheet=wb.Sheets[wb.SheetNames[0]];
  assert.equal(sheet.A2.v,'001');assert.equal(sheet.B2.t,'s');assert.equal(sheet.B2.f,undefined);assert.match(sheet.B3.v,/待核对/);
  assert.throws(()=>tableResult({columns:['A'],rows:[['x','y']]}),/列数/);
  assert.throws(()=>tableResult({columns:['A'],rows:[[{}]]}),/单元格/);
  assert.throws(()=>tableResult('```json\n{"columns":["A"],"rows":['),/完整/);
});
test('文件问答只接受实际纳入范围内的逐字引用',()=>{
  const evidence=documentEvidence('项目说明\n提交时间为周五下午五点\n负责人：小李','提交时间');
  const good={answer:'周五下午五点',citations:[{start:2,end:2,quote:'提交时间为周五下午五点'}]};
  assert.match(groundedAnswer(JSON.stringify(good),evidence),/第2~2行/);
  assert.throws(()=>groundedAnswer(JSON.stringify({...good,citations:[{start:2,end:2,quote:'周六下午'}]}),evidence),/不符/);
  assert.throws(()=>groundedAnswer(JSON.stringify({...good,citations:[{start:999,end:999,quote:'x'}]}),evidence),/未纳入/);
  assert.match(groundedAnswer(JSON.stringify({answer:'未知',citations:[]}),evidence),/未找到/);
});
test('长文件检索保留原始行号，超长行不静默冒充全文',()=>{
  const rows=Array.from({length:1000},(_,i)=>i===900?'截止日期是12月1日':'普通段落'+i);
  const evidence=documentEvidence(rows.join('\n'),'截止日期');
  assert.equal(evidence.partial,true);assert.ok(evidence.lines.some(v=>v.line===901));assert.ok(JSON.stringify(evidence).length<24000);
});

test('长行分块保留原行号，尾部答案可引用且不伪造全文覆盖',()=>{
  const evidence=documentEvidence('前言\n'+'普通文字。'.repeat(800)+'截止日期：10月31日\n结尾','截止日期');
  assert.ok(evidence.lines.some(v=>v.line===2&&v.text.includes('10月31日')));
  assert.match(groundedAnswer(JSON.stringify({answer:'10月31日',citations:[{start:2,end:2,quote:'截止日期：10月31日'}]}),evidence),/10月31日/);
  assert.ok(evidence.lines.every(v=>v.text.length<=2000));
  assert.ok(evidence.lines.some(v=>v.line===2&&v.columnStart>1));
});
test('长行片段不能跨未纳入的字符拼接引用，同一行多片段均可核对',()=>{
  const evidence={lines:[{line:1,text:'截止日期：周五',columnStart:1,columnEnd:7,lineLength:100},{line:1,text:'负责人：小李',columnStart:94,columnEnd:99,lineLength:100}]};
  const answer=quote=>JSON.stringify({answer:'核对',citations:[{start:1,end:1,quote}]});
  assert.match(groundedAnswer(answer('截止日期：周五'),evidence),/周五/);
  assert.match(groundedAnswer(answer('负责人：小李'),evidence),/小李/);
  assert.throws(()=>groundedAnswer(answer('周五负责人'),evidence),/不符/);
});
test('课程表按明确周次、星期和钟点展开，缺失节次时间拒绝',()=>{
  const raw={courses:[{title:'数学',weekday:1,start:'08:00',end:'09:40',weeks:[1,3],location:'A101'}]};
  const events=courseEvents(raw,'2026-10-26',16);
  assert.equal(events.length,2);assert.equal(events[0].at,Date.parse('2026-10-26T08:00:00+08:00'));
  assert.equal(events[1].at-events[0].at,14*86400000);
  assert.throws(()=>courseEvents(raw,'2026-10-27',16),/周一/);
  assert.throws(()=>courseEvents({courses:[{...raw.courses[0],start:'第一节'}]},'2026-10-26'),/时间/);
  assert.throws(()=>courseEvents({courses:[{...raw.courses[0],weeks:[1,17]}]},'2026-10-26',16),/周次/);
});
const calendar=body=>'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'+body+'\r\nEND:VCALENDAR';
const event=rows=>'BEGIN:VEVENT\r\n'+rows.join('\r\n')+'\r\nEND:VEVENT';
test('ICS UTC、上海和浮动时间一致；全天事项默认北京时间09:00',()=>{
  const now=Date.parse('2026-10-23T09:00:00+08:00');
  for(const time of ['DTSTART:20261024T020000Z','DTSTART;TZID=Asia/Shanghai:20261024T100000','DTSTART:20261024T100000']){
    const rows=calendarEvents(calendar(event(['UID:meeting','SUMMARY:会议',time])),now);
    assert.equal(rows[0].at,Date.parse('2026-10-24T10:00:00+08:00'));
  }
  const all=calendarEvents(calendar(event(['UID:all','SUMMARY:全天','DTSTART;VALUE=DATE:20261024'])),now);
  assert.equal(all[0].at,Date.parse('2026-10-24T09:00:00+08:00'));assert.equal(all[0].allDay,true);
});
test('ICS重复规则、排除日期和例外事件改期被正确处理',()=>{
  const raw=calendar(event(['UID:repeat','SUMMARY:原会议','DTSTART:20261024T020000Z','DTEND:20261024T030000Z','RRULE:FREQ=DAILY;COUNT=3','EXDATE:20261025T020000Z'])+'\r\n'+event(['UID:repeat','RECURRENCE-ID:20261026T020000Z','DTSTART:20261026T040000Z','DTEND:20261026T050000Z','SUMMARY:改期会议']));
  const rows=calendarEvents(raw,Date.parse('2026-10-23T00:00:00Z'));
  assert.equal(rows.length,2);assert.equal(rows[1].title,'改期会议');assert.equal(rows[1].at,Date.parse('2026-10-26T04:00:00Z'));
});
test('ICS未知时区和过大展开拒绝；过去事项不导入',()=>{
  const now=Date.parse('2026-10-23T00:00:00Z');
  assert.throws(()=>calendarEvents(calendar(event(['UID:x','DTSTART;TZID=Unknown/Zone:20261024T100000'])),now),/未定义时区/);
  assert.throws(()=>calendarEvents(calendar(event(['UID:x','DTSTART:20261024T020000Z','RRULE:FREQ=HOURLY;COUNT=500'])),now),/200项/);
  assert.equal(calendarEvents(calendar(event(['UID:old','DTSTART:20251024T020000Z'])),now).length,0);
});
test('RSS和Atom提取稳定ID，拒绝DTD和私密链接',()=>{
  const rss='<rss><channel><item><guid>a</guid><title>更新A</title><link>https://example.com/a</link></item></channel></rss>';
  assert.equal(feedItems(rss,'https://example.com/rss')[0].title,'更新A');
  const atom='<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>a</id><title>版本</title><link rel="alternate" href="/a"/></entry></feed>';
  assert.equal(feedItems(atom,'https://example.com/rss')[0].url,'https://example.com/a');
  assert.throws(()=>feedItems('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>','https://example.com'),/安全/);
  for(const url of ['http://127.0.0.1','http://[::1]','http://169.254.169.254','https://example.com/?token=hidden','https://example.com:8080'])assert.throws(()=>monitorUrl(url));
  const credentialUrl=new URL('https://example.com');credentialUrl.username='fixture';credentialUrl.password='fixture';assert.throws(()=>monitorUrl(credentialUrl.href));
});
