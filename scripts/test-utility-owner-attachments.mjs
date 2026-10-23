import {test} from 'node:test';import assert from 'node:assert/strict';
import {createUtilityOwner} from '../src/utility-owner.js';import {createUtilityAttachments} from '../src/utility-attachments.js';
import {utilityFixture,ownerCtx} from './utility-test-fixture.mjs';import {parseCompanionCommand} from '../src/companion.js';
const group={...ownerCtx,sourceKey:'group:456',quotedId:'77'};
test('weekly report is administrator-only, private, and requests the no-memory transport',async()=>{
  const f=utilityFixture({ownerFacts:()=>({memories:[{text:'真实回忆',createdAt:Date.parse('2026-10-22T08:00:00+08:00')}],notes:[],tasks:[],anniversaries:[]}),compose:async()=> '仅管理员可见的周记原文'});
  const o=createUtilityOwner(f.d),call=(ctx,s)=>o.handle(ctx,parseCompanionCommand(s));
  try {
    await assert.rejects(call({...group,userId:'234'},'[本周回忆]'),/管理员/);
    await call(group,'[本周回忆]');
    assert.equal(f.sent.filter(v=>v.text.includes('周记原文')).length,1);
    const report=f.sent.find(v=>v.text.includes('周记原文'));assert.equal(report.key,'private:123');assert.equal(report.privateReport,true);
    assert.ok(f.sent.filter(v=>v.key==='group:456').every(v=>!v.text.includes('周记原文')));
    assert.equal(JSON.stringify(f.d.store.read()).includes('周记原文'),false);
  }finally{f.close();}
});
test('daily overview reads original tasks but never changes them',async()=>{
  const tasks=[{id:'r_original',text:'原任务',at:Date.parse('2026-10-23T10:00:00+08:00')}],before=JSON.stringify(tasks);
  const f=utilityFixture({ownerFacts:()=>({notes:[{text:'待办事项',done:false}],tasks,anniversaries:[],memories:[]})}),o=createUtilityOwner(f.d);
  try{await o.handle(ownerCtx,parseCompanionCommand('[今日安排]'));assert.match(f.sent.at(-1).text,/原任务/);assert.equal(JSON.stringify(tasks),before);}
  finally{f.close();}
});
test('weekly generation refuses changed source data instead of sending an obsolete snapshot',async()=>{
  let release;const gate=new Promise(r=>{release=r;});const memories=[{text:'原内容',createdAt:Date.parse('2026-10-22T08:00:00+08:00')}];
  const f=utilityFixture({ownerFacts:()=>({memories}),compose:async()=>{await gate;return '旧快照内容';}}),o=createUtilityOwner(f.d);
  try{const work=o.weekly();memories[0].text='已更正';release();await assert.rejects(work,/来源已变化/);assert.equal(f.sent.length,0);}
  finally{f.close();}
});
test('announcement cannot be deleted during an in-flight confirmed publication',async()=>{
  let release;const gate=new Promise(r=>{release=r;});const f=utilityFixture({compose:async()=> '公告',say:async(ctx,text)=>{if(text==='公告')await gate;return true;}}),o=createUtilityOwner(f.d);
  try{
    await o.handle(group,parseCompanionCommand('[生成公告][改动]'));const id=f.d.store.owner('123').drafts[0].id;
    const work=o.handle(group,parseCompanionCommand('[发布公告]['+id+'][确认]'));
    await assert.rejects(o.handle(ownerCtx,parseCompanionCommand('[删除公告]['+id+'][确认]')),/正在发送/);
    release();await work;assert.ok(f.d.store.owner('123').drafts[0].completedAt);
  }finally{release?.();f.close();}
});
test('error archive stays private and requires confirmation for deletion',async()=>{
  const f=utilityFixture(),o=createUtilityOwner(f.d),call=s=>o.handle(group,parseCompanionCommand(s));
  try{
    await call('[记录报错][连接失败][连接被拒绝][端口不对][改为3650]');
    const row=f.d.store.owner('123').errors[0];
    await call('[查报错][端口]');assert.match(f.sent.findLast(v=>v.key==='private:123').text,/改为3650/);
    assert.ok(f.sent.filter(v=>v.key==='group:456').every(v=>!v.text.includes('连接被拒绝')));
    await assert.rejects(call('[删除报错]['+row.id+']'),/确认/);
  }finally{f.close();}
});
test('announcements are drafts until explicit publication, retain target and reject duplicate sends',async()=>{
  const f=utilityFixture({compose:async()=> '本次更新了天气查询。'}),o=createUtilityOwner(f.d),call=s=>o.handle(group,parseCompanionCommand(s));
  try{
    await call('[生成公告][更新天气]');assert.ok(f.sent.filter(v=>v.key==='group:456').every(v=>!v.text.includes('本次更新了天气查询')));
    const id=f.d.store.owner('123').drafts[0].id;
    await assert.rejects(call('[发布公告]['+id+']'),/确认/);
    await call('[发布公告]['+id+'][确认]');
    assert.equal(f.sent.filter(v=>v.key==='group:456'&&v.text==='本次更新了天气查询。').length,1);
    await assert.rejects(call('[发布公告]['+id+'][确认]'),/已发布/);
  }finally{f.close();}
});
test('screenshot task previews require scoped ID and confirmation, prevent duplicate consumption',async()=>{
  const f=utilityFixture({extractTasks:async()=> '{"tasks":[{"text":"交报告","dueText":"明天9点"}]}'});
  const a=createUtilityAttachments(f.d),call=(ctx,s)=>a.handle(ctx,parseCompanionCommand(s));
  try{
    await call(group,'[截图待办]');assert.equal(f.d.store.profile('123').todos.length,0);
    const id=/p_[a-f0-9]{12}/.exec(f.sent.at(-1).text)[0];
    await assert.rejects(call({...group,userId:'234'},'[确认截图待办]['+id+'][确认]'),/失效|本会话/);
    await call(group,'[确认截图待办]['+id+'][确认]');
    assert.equal(f.d.store.profile('123').todos.length,1);assert.ok(f.d.store.profile('123').todos[0].dueAt>f.d.now());
    await assert.rejects(call(group,'[确认截图待办]['+id+'][确认]'),/失效/);
  }finally{f.close();}
});
test('file versions are private to their actor and expire',async()=>{
  let content='第一行\n原文';const f=utilityFixture({readMessage:async()=>content}),a=createUtilityAttachments(f.d),call=(ctx,s)=>a.handle(ctx,parseCompanionCommand(s));
  try{
    await call(group,'[文件暂存][旧版]');content='第一行\n新版';await call(group,'[文件暂存][新版]');
    await call(group,'[文件对比][旧版][新版]');assert.match(f.sent.at(-1).text,/新增.*新版/s);
    await assert.rejects(call({...group,userId:'234'},'[文件对比][旧版][新版]'),/暂存/);
    f.advance(900001);await assert.rejects(call(group,'[文件对比][旧版][新版]'),/暂存|过期/);
  }finally{f.close();}
});
