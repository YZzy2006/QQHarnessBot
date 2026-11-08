import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createUtilities} from '../src/utilities.js';
import {utilityFixture,ownerCtx} from './utility-test-fixture.mjs';
import {utilityId} from '../src/utility-store.js';
import {digest} from '../src/practical-data.js';

const group={...ownerCtx,sourceKey:'group:456',quotedId:'77'};
const rss=(...ids)=>'<rss><channel>'+ids.map(id=>'<item><guid>'+id+'</guid><title>更新'+id+'</title><link>https://example.com/'+id+'</link></item>').join('')+'</channel></rss>';
function fixture(extra={}){
  const files=[],f=utilityFixture({
    canNotify:()=>true,
    extractStructured:async(q,kind)=>kind==='table'?JSON.stringify({columns:['编号','事项'],rows:[['001','测试']]}):JSON.stringify({courses:[{title:'数学',weekday:1,start:'08:00',end:'09:40',weeks:[1,2],location:'A101'}]}),
    readMessage:async()=> '提交截止时间\n周五下午五点',
    compose:async()=>JSON.stringify({answer:'周五下午五点',citations:[{start:2,end:2,quote:'周五下午五点'}]}),
    sendFile:async(key,data,authorize)=>{assert.equal(authorize(),true);files.push({key,...data});return true;},
    fetchPublic:async url=>({statusCode:200,url,truncated:false,body:rss('a')}),
    ...extra
  });
  const u=createUtilities(f.d),call=(text,ctx=group)=>u.handle(ctx,text);
  return {...f,u,call,files};
}
const previewId=f=>/p_[a-f0-9]{12}/.exec(f.sent.at(-1).text)?.[0];

function calendarRow(f,owner,index,{at=f.d.now()+60000,end=at+300000}={}){
  return {id:utilityId('z'),owner,createdAt:f.d.now(),title:'测试会议'+index,location:'',at,end,notifyAt:Math.min(at,f.d.now()-1000),until:Math.max(end,at+3600000),fingerprint:digest(String(index))};
}
test('前五项受限的日历不阻塞其他用户，过期项即使受限也标记过期',async()=>{
  const f=fixture({canNotify:key=>key==='private:234'});
  try{
    f.u.practical.store.change(s=>s.events.push(...Array.from({length:5},(_,i)=>calendarRow(f,'123',i)),calendarRow(f,'234',5),calendarRow(f,'123',6,{at:f.d.now()-7200000,end:f.d.now()-7100000})));
    await f.u.practical.tick();
    assert.equal(f.sent.filter(v=>v.text.includes('【日历提醒】')).length,1);
    assert.equal(f.u.practical.store.read().events[5].delivery,'sent');
    assert.equal(f.u.practical.store.read().events[6].delivery,'expired');
  }finally{f.close();}
});
test('前两条受限的待发订阅不阻塞其他用户',async()=>{
  const f=fixture({canNotify:key=>key==='private:234'});
  try{
    f.u.practical.store.change(s=>s.watches.push(...['123','123','234'].map((owner,i)=>({id:utilityId('z'),owner,createdAt:f.d.now(),kind:'health',url:'https://example.com/'+i,interval:300000,nextAt:f.d.now()+300000,failures:0,health:'up',seen:[],pending:{id:digest('notice-'+i),text:'待发通知'+i,state:'ready'}}))));
    await f.u.practical.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].key,'private:234');
    assert.equal(f.u.practical.store.read().watches[2].pending,undefined);
  }finally{f.close();}
});
test('有结束时间的短会议不补发，兼容旧记录的一小时宽限；无结束时间仍可宽限',async()=>{
  const f=fixture();
  try{
    const at=f.d.now()-1800000;
    f.u.practical.store.change(s=>s.events.push(calendarRow(f,'123',1,{at,end:at+300000}),calendarRow(f,'123',2,{at,end:at})));
    await f.u.practical.tick();
    assert.equal(f.u.practical.store.read().events[0].delivery,'expired');
    assert.equal(f.u.practical.store.read().events[1].delivery,'sent');
    assert.equal(f.sent.filter(v=>v.text.includes('【日历提醒】')).length,1);
  }finally{f.close();}
});
test('过期清理先预览确认且隔离本人；日历按导入批次删除',async()=>{
  const f=fixture();
  try{
    const at=f.d.now()-7200000;
    f.u.practical.store.change(s=>s.events.push(calendarRow(f,'123',1,{at,end:at+300000}),calendarRow(f,'234',2,{at,end:at+300000})));
    await f.call('[清理已结束日历]');const cleanup=previewId(f);assert.ok(cleanup);assert.equal(f.u.practical.store.read().events.length,2);
    await f.call('[清理已结束日历]['+cleanup+'][确认]',{...group,userId:'234'});assert.equal(f.u.practical.store.read().events.length,2);
    await f.call('[清理已结束日历]['+cleanup+'][确认]');assert.deepEqual(f.u.practical.store.read().events.map(e=>e.owner),['234']);
    f.d.getMessage=async()=>({group_id:456,sender:{user_id:123},message:[{type:'image',data:{file:'fixture.png'}}]});
    await f.call('[课程表导入][2026-10-26][16][10]');const id=previewId(f);assert.ok(id);
    await f.call('[确认日历导入]['+id+'][确认]');const batch=f.u.practical.store.read().events.find(e=>e.owner==='123').batchId;assert.match(batch,/^b_[a-f0-9]{12}$/);
    await f.call('[我的日历批次]');assert.ok(f.sent.some(v=>v.key==='private:123'&&v.text.includes(batch)));
    await f.call('[删除日历批次]['+batch+'][确认]',{...group,userId:'234'});assert.equal(f.u.practical.store.read().events.length,3);
    await f.call('[删除日历批次]['+batch+'][确认]');assert.deepEqual(f.u.practical.store.read().events.map(e=>e.owner),['234']);
  }finally{f.close();}
});
test('订阅展示检查时间和安全错误原因，网页通知包含变化前后片段',async()=>{
  let status=200,body='<p>公告：开放报名</p>';
  const f=fixture({fetchPublic:async()=>({statusCode:status,body})});
  try{
    await f.call('[订阅网页][https://example.com/notice][5]');
    body='<p>公告：报名截止</p>';f.advance(300001);await f.u.practical.tick();
    const notice=f.sent.find(v=>v.text.includes('【网页更新】'))?.text||'';assert.match(notice,/之前片段：[\s\S]*开放报名[\s\S]*当前片段：[\s\S]*报名截止/);
    status=503;f.advance(300001);await f.u.practical.tick();await f.call('[我的订阅]');
    const text=f.sent.findLast(v=>v.key==='private:123').text;assert.match(text,/上次检查/);assert.match(text,/下次检查/);assert.match(text,/HTTP 503/);
  }finally{f.close();}
});

test('截图先预览确认再导出，会话成员隔离，过期和重复请求拒绝',async()=>{
  const f=fixture();
  try{
    await f.call('[截图转表格]');const id=previewId(f);assert.ok(id);assert.equal(f.files.length,0);
    await f.call('[导出表格]['+id+'][确认]',{...group,userId:'234'});assert.equal(f.files.length,0);
    await f.call('[导出表格]['+id+'][确认]',{...group,sourceKey:'group:789'});assert.equal(f.files.length,0);
    await f.call('[导出表格]['+id+'][确认]');assert.equal(f.files.length,1);assert.equal(f.files[0].key,group.sourceKey);
    await f.call('[导出表格]['+id+'][确认]');assert.equal(f.files.length,1);
    f.advance(16000);await f.call('[截图转表格]');const expired=previewId(f);f.advance(600001);
    await f.call('[导出表格]['+expired+'][确认]');assert.equal(f.files.length,1);assert.match(f.sent.at(-1).text,/过期/);
    assert.equal(JSON.stringify(f.u.practical.store.read()).includes('001'),false);
  }finally{f.close();}
});
test('文件回执不明不自动再上传，重新确认同预览也拒绝',async()=>{
  let attempts=0;const f=fixture({sendFile:async()=>{attempts++;throw Error('timeout');}});
  try{
    await f.call('[截图转表格]');const id=previewId(f);
    await f.call('[导出表格]['+id+'][确认]');assert.match(f.sent.at(-1).text,/未确认送达/);
    await f.call('[导出表格]['+id+'][确认]');assert.equal(attempts,1);
  }finally{f.close();}
});
test('文件问答复用原文件暂存，标记原文位置和本人缓存范围',async()=>{
  const f=fixture();
  try{
    await f.call('[文件暂存][合同]');await f.call('[文件问答][合同][何时截止]');
    assert.match(f.sent.at(-1).text,/来源消息：77[\s\S]*第2~2行/);
    await f.call('[文件问答][合同][何时截止]',{...group,userId:'234'});assert.match(f.sent.at(-1).text,/没有.*暂存/);
    await f.call('[文件问答][何时截止]');assert.match(f.sent.at(-1).text,/过于频繁/);
    f.advance(16000);await f.call('[文件问答][何时截止]');assert.match(f.sent.at(-1).text,/周五下午/);
    f.advance(900001);await f.call('[文件问答][何时截止]',{...group,quotedId:undefined});assert.match(f.sent.at(-1).text,/缓存15分钟过期/);
    assert.equal(fs.existsSync(f.d.stateDir+'/practical.json'),false);
  }finally{f.close();}
});
test('伪造文件引用和跨群引用不会进入模型，实际处理仍不写聊天记忆',async()=>{
  let models=0;const f=fixture({compose:async()=>{models++;return '{}';},getMessage:async()=>({group_id:789,message:[],sender:{user_id:123}})});
  try{await f.call('[文件问答][问题]');assert.equal(models,0);assert.match(f.sent.at(-1).text,/不属于当前会话/);}finally{f.close();}
});
test('课程表确认前不保存，重复导入不重建，提醒只发本人且重启不重复',async()=>{
  const f=fixture();
  try{
    f.d.getMessage=async()=>({group_id:456,sender:{user_id:123},message:[{type:'image',data:{file:'fixture.png'}}]});
    await f.call('[课程表导入][2026-10-26][16][10]');const id=previewId(f);assert.ok(id);assert.equal(f.u.practical.store.read().events.length,0);
    await f.call('[确认日历导入]['+id+'][确认]');assert.equal(f.u.practical.store.read().events.length,2);
    f.advance(16000);await f.call('[课程表导入][2026-10-26][16][10]');assert.match(f.sent.at(-1).text,/全部导入/);
    const e=f.u.practical.store.read().events[0];f.advance(e.at-f.d.now());
    f.d.store.editProfile('123',p=>{p.quietStart=22;p.quietEnd=7;});
    await f.u.tick();assert.equal(f.u.practical.store.read().events[0].delivery,'sent');
    const notices=f.sent.filter(v=>v.text.includes('【日历提醒】'));assert.equal(notices.length,1);assert.equal(notices[0].key,'private:123');
    const second=createUtilities(f.d);await second.tick();assert.equal(f.sent.filter(v=>v.text.includes('【日历提醒】')).length,1);
    await f.call('[删除日历]['+e.id+'][确认]',{...group,userId:'234'});assert.equal(f.u.practical.store.read().events.length,2);
    await f.call('[删除日历]['+e.id+'][确认]');assert.equal(f.u.practical.store.read().events.length,1);
  }finally{f.close();}
});
test('日历导入尊重私聊白名单、原存储损坏时失败关闭',async()=>{
  const f=fixture({isAllowed:key=>key!=='private:123',readMessage:async()=> 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261026T020000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'});
  try{
    await f.call('[日历导入]');assert.match(f.sent.at(-1).text,/私聊不在白名单/);assert.equal(f.u.practical.store.read().events.length,0);
    fs.writeFileSync(f.u.practical.store.file,'broken');
    await f.call('[我的日历]');assert.match(f.sent.at(-1).text,/存储损坏/);assert.equal(fs.readFileSync(f.u.practical.store.file,'utf8'),'broken');
  }finally{f.close();}
});
test('RSS首次建立基线，新增合并通知，重复、取消和重新启动均不重放',async()=>{
  let body=rss('a');const f=fixture({fetchPublic:async url=>({statusCode:200,url,body})});
  try{
    await f.call('[订阅更新][https://example.com/feed][5]');const w=f.u.practical.store.read().watches[0];assert.ok(w);assert.equal(w.seen.length,1);
    body=rss('b','a');f.advance(300001);await f.u.tick();
    assert.equal(f.sent.filter(v=>v.text.includes('【订阅更新】')).length,1);
    f.advance(300001);await createUtilities(f.d).tick();assert.equal(f.sent.filter(v=>v.text.includes('【订阅更新】')).length,1);
    await f.call('[订阅更新][https://example.com/feed][5]');assert.equal(f.u.practical.store.read().watches.length,1);
    await f.call('[取消订阅]['+w.id+'][确认]',{...group,userId:'234'});assert.equal(f.u.practical.store.read().watches.length,1);
    await f.call('[取消订阅]['+w.id+'][确认]');assert.equal(f.u.practical.store.read().watches.length,0);
  }finally{f.close();}
});
test('异常连续三次告警、持续故障不刷屏、恢复只通知一次',async()=>{
  let status=200;const f=fixture({fetchPublic:async()=>({statusCode:status,body:''})});
  try{
    await f.call('[异常监测][https://example.com/][5]');status=503;
    for(let i=0;i<2;i++){f.advance(300001);await f.u.tick();}assert.equal(f.sent.filter(v=>v.text.includes('【连续异常】')).length,0);
    f.advance(300001);await f.u.tick();assert.equal(f.sent.filter(v=>v.text.includes('【连续异常】')).length,1);
    f.advance(300001);await f.u.tick();assert.equal(f.sent.filter(v=>v.text.includes('【连续异常】')).length,1);
    status=200;f.advance(300001);await f.u.tick();assert.equal(f.sent.filter(v=>v.text.includes('【监测恢复】')).length,1);
    f.advance(300001);await f.u.tick();assert.equal(f.sent.filter(v=>v.text.includes('【监测恢复】')).length,1);
  }finally{f.close();}
});
test('静默时保留通知；发送回执不明不重试，显式恢复放弃旧通知',async()=>{
  let body=rss('a'),allowed=false,attempts=0;
  const f=fixture({canNotify:()=>allowed,fetchPublic:async()=>({statusCode:200,body})});
  f.d.send=async(key,text)=>{if(text.includes('【订阅更新】')){attempts++;return false;}f.sent.push({key,text});return true;};
  const u=createUtilities(f.d);
  try{
    await u.handle(group,'[订阅更新][https://example.com/feed][5]');body=rss('b','a');f.advance(300001);await u.tick();
    assert.equal(u.practical.store.read().watches[0].pending.state,'ready');assert.equal(attempts,0);
    allowed=true;await u.tick();assert.equal(attempts,1);assert.equal(u.practical.store.read().watches[0].pending.state,'unknown');
    f.advance(300001);await createUtilities(f.d).tick();assert.equal(attempts,1);
    const id=u.practical.store.read().watches[0].id;await u.handle(group,'[恢复订阅]['+id+'][确认]');await u.tick();assert.equal(attempts,1);
  }finally{f.close();}
});
test('取消在途订阅不会复活，关闭扩展抑制在途输出',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let first=true;
  const f=fixture({fetchPublic:async()=>{if(first){first=false;return {statusCode:200,body:rss('a')};}entered();await gate;return {statusCode:200,body:rss('b')};}});
  try{
    await f.call('[订阅更新][https://example.com/feed][5]');const id=f.u.practical.store.read().watches[0].id;
    f.advance(300001);const pending=f.u.tick();await started;await f.call('[取消订阅]['+id+'][确认]');release();await pending;
    assert.equal(f.u.practical.store.read().watches.length,0);assert.equal(f.sent.some(v=>v.text.includes('【订阅更新】')),false);
  }finally{release();f.close();}
});

test('网页订阅忽略脚本变动，正文变化通知一次；大网页HTTP成功不误报异常',async()=>{
  let body='<html><script>counter=1</script><body>公告：开放报名</body></html>';
  const f=fixture({fetchPublic:async()=>({statusCode:200,body})});
  try{
    await f.call('[订阅网页][https://example.com/notice][5][公告]');
    assert.ok(f.sent.some(v=>v.text.includes('网页订阅')));
    body=body.replace('counter=1','counter=2');f.advance(300001);await f.u.tick();assert.equal(f.sent.some(v=>v.text.includes('【网页更新】')),false);
    body=body.replace('开放报名','报名截止');f.advance(300001);await f.u.tick();assert.equal(f.sent.filter(v=>v.text.includes('【网页更新】')).length,1);
    const w=f.u.practical.store.read().watches[0];assert.equal(w.seen.length,1);
    assert.equal(JSON.stringify(f.u.practical.store.read()).includes('<html>'),false);
    await f.call('[取消订阅]['+w.id+'][确认]');
    f.d.fetchPublic=async()=>({statusCode:200,body:'truncated',truncated:true});
    const h=createUtilities(f.d);await h.handle(group,'[异常监测][https://example.com/health][5]');
    for(let i=0;i<3;i++){f.advance(300001);await h.tick();}
    assert.equal(h.practical.store.read().watches[0].failures,0);
  }finally{f.close();}
});

test('关闭扩展时抑制在途模型结果',async()=>{
  let enabled=true,release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const f=fixture({isEnabled:()=>enabled,extractStructured:async()=>{entered();await gate;return JSON.stringify({columns:['A'],rows:[['不应发出']]});}});
  try{
    const pending=f.call('[截图转表格]');await started;enabled=false;release();await pending;
    assert.equal(f.sent.some(v=>v.text.includes('不应发出')),false);
    assert.equal(f.files.length,0);
  }finally{release();f.close();}
});

test('不写原任务文件，UTC日历实际入口正确导入并在时效内提醒',async()=>{
  const f=fixture({readMessage:async()=> 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fixture-utc\r\nSUMMARY:会议\r\nDTSTART:20261023T020000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'});
  try{
    const old=f.d.stateDir+'/reminders.json';fs.writeFileSync(old,'{"original":true}');
    await f.call('[日历导入][0]');const id=previewId(f);assert.ok(id);
    await f.call('[确认日历导入]['+id+'][确认]');
    assert.equal(f.u.practical.store.read().events[0].at,Date.parse('2026-10-23T10:00:00+08:00'));
    assert.equal(fs.readFileSync(old,'utf8'),'{"original":true}');
    f.advance(3600000);await f.u.tick();assert.ok(f.sent.some(v=>v.text.includes('【日历提醒】')));
    assert.equal(fs.readFileSync(old,'utf8'),'{"original":true}');
  }finally{f.close();}
});

test('引用读取期间撤销权限后不再提交模型；队列中的订阅通知可被取消',async()=>{
  let enabled=true,models=0;
  const f=fixture({isEnabled:()=>enabled,getMessage:async()=>{enabled=false;return {group_id:456,message:[{type:'image',data:{file:'fixture.png'}}]};},extractStructured:async()=>{models++;return '{}';}});
  try{await f.call('[截图转表格]');assert.equal(models,0);}finally{f.close();}
  let body=rss('a'),release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);const sent=[];
  const g=fixture({fetchPublic:async()=>({statusCode:200,body}),send:async(key,text,opts)=>{
    if(text.includes('【订阅更新】')){entered();await gate;if(!opts.authorize())return false;sent.push(text);}return true;
  }});
  try{
    await g.call('[订阅更新][https://example.com/feed][5]');const id=g.u.practical.store.read().watches[0].id;
    body=rss('b');g.advance(300001);const work=g.u.tick();await started;await g.call('[取消订阅]['+id+'][确认]');release();await work;
    assert.equal(sent.length,0);assert.equal(g.u.practical.store.read().watches.length,0);
  }finally{release();g.close();}
});
