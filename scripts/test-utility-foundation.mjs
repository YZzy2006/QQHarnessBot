import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createUtilityStore} from '../src/utility-store.js';
import {checkedQuote, compareDocuments, parseTaskPreview, weekStart} from '../src/utility-content.js';
import {createPrivateReportGuard, PRIVATE_REPORT_MARKER} from '../src/private-report-guard.js';
import {summarizeOwnerMessages} from '../src/owner-summary.js';
test('weekly and announcement generation keeps configured model/effort, no tools, and accounts usage',async()=>{
  let request,usage;
  const result=await summarizeOwnerMessages({text:JSON.stringify({kind:'weekly',facts:{memories:['明确保存的原文']}}),purpose:'utility',provider:'deepseek-official',model:'deepseek-flash',effort:'max',apiKey:'fixture',
    fetchImpl:async(url,opts)=>{request=JSON.parse(opts.body);return Response.json({choices:[{finish_reason:'stop',message:{content:'本周回顾'}}],usage:{prompt_tokens:10,completion_tokens:5}});},onUsage:v=>{usage=v;}});
  assert.equal(result,'本周回顾');assert.equal(request.model,'deepseek-flash');assert.equal(request.reasoning_effort,'max');assert.equal(request.tools,undefined);
  assert.match(request.messages[0].content,/管理员私有周记/);assert.equal(usage.completion_tokens,5);
});
test('utility store persists independently, rolls back invalid changes and refuses corruption', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utility-store-'));
  try {
    const s=createUtilityStore({stateDir:dir});
    s.change(v=>{v.profiles['123']=s.newProfile(); v.profiles['123'].city='广州';});
    assert.equal(createUtilityStore({stateDir:dir}).read().profiles['123'].city,'广州');
    assert.throws(()=>s.change(v=>{v.profiles['bad']=s.newProfile();}), /格式/);
    assert.equal(s.read().profiles.bad,undefined);
    const fail=createUtilityStore({stateDir:dir,backup:()=>{throw Error('backup failed');}});
    assert.throws(()=>fail.change(v=>{v.profiles['123'].city='北京';}),/backup failed/);
    assert.equal(s.read().profiles['123'].city,'广州');
    fs.writeFileSync(s.file,'{}');
    assert.throws(()=>s.change(()=>{}),/损坏/);
    assert.equal(fs.readFileSync(s.file,'utf8'),'{}');
    assert.equal(fs.existsSync(path.join(dir,'reminders.json')),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('quotes require actual conversation and reject cross-group or unknown private provenance',()=>{
  const ctx={sourceKey:'group:456',userId:'123'};
  assert.equal(checkedQuote(ctx,{group_id:456,message:[],sender:{user_id:234}}).group_id,456);
  assert.throws(()=>checkedQuote(ctx,{group_id:789,message:[]}),/当前会话/);
  assert.throws(()=>checkedQuote({sourceKey:'private:123',userId:'123'},{sender:{user_id:234},message:[]}),/当前会话/);
});
test('document comparison reports actual changes and honestly bounds coverage',()=>{
  const r=compareDocuments('第一行\n原内容\n第三行','第一行\n新内容\n第三行');
  assert.match(r,/删除.*原内容/s); assert.match(r,/新增.*新内容/s);
  assert.match(compareDocuments('相同','相同'),/没有发现/);
  assert.match(compareDocuments('x\n'.repeat(800),'y\n'.repeat(800)),/截断/);
});
test('screenshot previews validate structured output and require readable task text',()=>{
  assert.deepEqual(parseTaskPreview('{"tasks":[{"text":"交报告","dueText":"明天9点"}]}'),[{text:'交报告',dueText:'明天9点'}]);
  assert.throws(()=>parseTaskPreview('{"tasks":[{"text":""}]}'),/待办/);
  assert.throws(()=>parseTaskPreview('{"tasks":[]}'),/待办/);
  assert.equal(weekStart(Date.parse('2026-10-23T08:00:00+08:00')),Date.parse('2026-10-19T00:00:00+08:00'));
});
test('private report guard stores only hashes and IDs, persists blocks, never stores report body',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utility-privacy-'));
  try {
    const g=createPrivateReportGuard({stateDir:dir}); const body=PRIVATE_REPORT_MARKER+'\n这是只能给管理员看的周记原文';
    g.remember('private:123',body,['990']);
    assert.equal(g.blocks('private:123','990',''),true);
    assert.equal(g.blocks('private:123',null,body),true);
    assert.equal(createPrivateReportGuard({stateDir:dir}).blocks('private:123','990',''),true);
    assert.equal(g.blocks('private:234','990','普通消息'),false);
    assert.equal(fs.readFileSync(g.file,'utf8').includes('周记原文'),false);
    fs.writeFileSync(g.file,'{}');
    assert.throws(()=>g.remember('private:123','body'),/损坏/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
