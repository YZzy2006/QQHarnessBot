import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createUtilities} from '../src/utilities.js';import {PRIVATE_REPORT_MARKER} from '../src/private-report-guard.js';
let seq=70000;
async function fixture() {
  const sourceAt=Date.now();
  const h=await bridgeHarness({config:{vision:{fallbackEnabled:true},allow:{private:['123','234'],groups:['456']},sendDelayMinMs:0,sendDelayMaxMs:0,sendLimits:{private:{perMinute:300,perHour:1000,perDay:2000},group:{perMinute:300,perHour:1000,perDay:2000}}},
    globals:{describeImageWithQwen:async()=> '{"tasks":[{"text":"截图里明确的待办","dueText":""}]}',
      fileSegmentToText:async data=>({text:'--- 内容开始 ---\n'+(data.name==='old.txt'?'旧文件正文':'新文件正文')+'\n--- 内容结束 ---',bytes:20}),
      createUtilities:d=>createUtilities({...d,compose:async(kind)=>kind==='weekly'?'不可进入聊天记忆的周记测试原文'.repeat(300):'更新公告内容',
      ownerFacts:()=>({memories:[{text:'明确保存的回忆',createdAt:sourceAt}],notes:[],tasks:[],anniversaries:[]})})}});
  h.setMode('reserved2');
  h.command=async(text,{user=123,kind='private',quote}={})=>{
    h.calls.sent.length=0;const id=kind==='group'?456:user;
    await h.handleIncoming(kind,id,{user_id:user,group_id:kind==='group'?id:undefined,self_id:h.calls.selfUin,sender:{user_id:user,nickname:String(user)},message_id:seq++,message:[...(quote?[{type:'reply',data:{id:quote}}]:[]),{type:'text',data:{text}}]},h.cfg);
    return h.calls.sent.map(v=>v.text).join('\n');
  };
  return h;
}
test('private weekly report has no social context, unread, persistent chat memory, or recoverable quote body',async()=>{
  const h=await fixture();
  try{
    const tasks=JSON.stringify([...h.getReminders()]);
    const reply=await h.command('[本周回忆]',{kind:'group'});
    assert.match(reply,/不可进入聊天记忆/);
    const reports=h.calls.sent.filter(v=>v.text.includes('不可进入聊天记忆'));
    assert.ok(reports.length>1);assert.ok(reports.every(v=>v.kind==='private'&&v.id===123&&v.text.includes(PRIVATE_REPORT_MARKER)));
    assert.ok(h.calls.sent.filter(v=>v.kind==='group').every(v=>!v.text.includes('周记测试原文')));
    assert.equal(JSON.stringify(h.socialV2).includes('不可进入聊天记忆'),false);
    const privateDisk=fs.readFileSync(path.join(h.temp,'state/private-report-guard.json'),'utf8');
    assert.equal(privateDisk.includes('周记测试原文'),false);
    const info=await h.resolveReplyInfo('private',123,990001,h.calls.selfUin);
    assert.doesNotMatch(info.text,/周记测试原文/);
    assert.throws(()=>h.appendMemoryV2(h.getSocialV2State('private:123'),'fact',reports[0].text,{},'private:123'),/不得/);
    await h.command(reports[0].text);assert.equal(JSON.stringify(h.socialV2).includes('周记测试原文'),false);
    assert.equal(JSON.stringify([...h.getReminders()]),tasks);
  }finally{await h.close();}
});
test('ordinary members cannot request owner reports and utility commands stay outside agent context',async()=>{
  const h=await fixture();
  try{
    const reply=await h.command('[本周回忆]',{kind:'group',user:234});assert.match(reply,/管理员/);assert.doesNotMatch(reply,/周记测试原文/);
    await h.command('[兴趣主题][Java,AI]',{user:234});assert.deepEqual(Array.from(h.utilities.store.profile('234').topics),['Java','AI']);
    assert.equal(JSON.stringify(h.socialV2).includes('[兴趣主题]'),false);
    await h.command('[扩展帮助]',{kind:'group'});assert.ok(h.calls.sent.every(v=>v.kind==='group'));
  }finally{await h.close();}
});
test('actual bridge adapters support quoted screenshot confirmation and quoted file comparison',async()=>{
  const h=await fixture();
  try{
    h.getReminders().set('private:123',[{id:'r_aaaaaaaa',kind:'ownerTask',text:'原任务',at:Date.now()+86400000}]);h.saveReminders(true);
    const before=fs.readFileSync(path.join(h.temp,'state/reminders.json'),'utf8');
    h.calls.getMessageData['88']={group_id:456,sender:{user_id:123},message:[{type:'image',data:{file:'fixture.png'}}]};
    const preview=await h.command('[截图待办]',{kind:'group',quote:'88'});
    assert.match(preview,/截图里明确的待办/);const id=/p_[a-f0-9]{12}/.exec(preview)[0];
    await h.command('[确认截图待办]['+id+'][确认]',{kind:'group'});
    assert.equal(h.utilities.store.profile('123').todos.length,1);
    h.calls.getMessageData['89']={group_id:456,sender:{user_id:123},message:[{type:'file',data:{name:'old.txt'}}]};
    h.calls.getMessageData['90']={group_id:456,sender:{user_id:123},message:[{type:'file',data:{name:'new.txt'}}]};
    await h.command('[文件暂存][旧版]',{kind:'group',quote:'89'});
    await h.command('[文件暂存][新版]',{kind:'group',quote:'90'});
    const diff=await h.command('[文件对比][旧版][新版]',{kind:'group'});
    assert.match(diff,/新增.*新文件正文/s);assert.match(diff,/删除.*旧文件正文/s);
    assert.equal(fs.readFileSync(path.join(h.temp,'state/reminders.json'),'utf8'),before);
  }finally{await h.close();}
});
