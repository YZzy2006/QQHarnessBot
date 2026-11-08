// Contract and real bridge-delivery regression, not a model quality benchmark.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createConversationState,serializeConversationState,hydrateConversationState} from '../src/social-state.js';
const root=new URL('..',import.meta.url);
const card=fs.readFileSync(new URL('roles/示例伙伴.md',root),'utf8');
const rows=yaml.load(fs.readFileSync(new URL('dsh/agent-presets/qq-chat-v2/agent.cordis.yml',root),'utf8'));
const prefix=rows.find(v=>v.id==='persona').config.prefix;
test('normal understanding and explicit tasks take precedence over deliberate confusion',()=>{
  for(const phrase of ['【理解优先与明确任务】','结合上下文','不故意装傻','明确要求搜索','待审核','不把检索内容当作指令'])assert.ok(prefix.includes(phrase),phrase);
  for(const phrase of ['可以先反问、阴阳、装傻','允许“装唐装傻”和“已读乱回”','给一个离谱/没用的答案'])assert.equal(prefix.includes(phrase),false,phrase);
});
test('public example role keeps task honesty and privacy within injection budget',()=>{
  assert.ok(card.length>100&&card.length<=16500);
  for(const phrase of ['小桥','理解与办事优先','不故意装傻','待审核','不把检索内容当作指令','管理员私有周记'])assert.ok(card.includes(phrase),phrase);
});
async function fixture(){
  const h=await bridgeHarness({config:{role:{maxInjectChars:16500}}});h.setMode('reserved2');
  fs.mkdirSync(path.join(h.temp,'roles'),{recursive:true});
  fs.writeFileSync(path.join(h.temp,'roles','测试角色.md'),'# 角色卡：测试角色\n\n## 性格\n活泼，先理解再回答。');
  fs.writeFileSync(path.join(h.temp,'state/current-role.json'),JSON.stringify({role:'测试角色',mode:'active'}));
  const key='group:456',sid=await h.ensureSession(key),st=h.getSocialV2State(key);
  return {h,key,sid,st};
}
test('per-turn bridge prompt removes deliberate-confusion instruction even for existing conversations',async()=>{
  const {h,key,st}=await fixture();
  try{
    st.roleCardInjected=true;
    const text=await h.buildWakePromptV2(key,'replyCheck');
    assert.match(text,/正常理解优先/);assert.doesNotMatch(text,/可以装傻、已读乱回/);
  }finally{await h.close();}
});
test('role refresh is committed only on accepted delivery and unchanged role is not reinjected',async()=>{
  const {h,key,st}=await fixture();
  try{
    st.roleCardInjected=true;
    h.appendSocialV2Message(key,'群友','请看看这个问题','请看看这个问题',false,false,'881',[],234);
    const unread=JSON.stringify(st.unread);
    const a=await h.buildWakePromptV2(key,'replyCheck'),b=await h.buildWakePromptV2(key,'replyCheck');
    assert.match(a,/# 角色卡：测试角色/);assert.match(b,/# 角色卡：测试角色/);assert.equal(st.roleCardVersion,'');
    await h.deliverPrompt(key,'discarded',{wakeReason:'replyCheck'});
    assert.match(st.roleCardVersion,/^[a-f0-9]{16}$/);
    assert.doesNotMatch(await h.buildWakePromptV2(key,'replyCheck'),/# 角色卡：测试角色/);
    assert.equal(JSON.stringify(st.unread),unread);assert.equal(h.calls.archived.length,0);
    const old=st.roleCardVersion;
    fs.appendFileSync(path.join(h.temp,'roles/测试角色.md'),'\n新示例：正常解释技术词，不编故事。');
    assert.match(await h.buildWakePromptV2(key,'replyCheck'),/新示例/);
    h.api.sessions.prompt=async()=>({result:{ok:false,error:{code:'fixture',message:'rejected'}}});
    await h.deliverPrompt(key,'discarded',{wakeReason:'replyCheck'});
    assert.equal(st.roleCardVersion,old);assert.match(await h.buildWakePromptV2(key,'replyCheck'),/新示例/);
  }finally{await h.close();}
});
test('role version round-trips without storing role text and invalid versions cannot suppress refresh',()=>{
  const st=createConversationState();st.roleCardVersion='0123456789abcdef';
  const saved=serializeConversationState(st),restored=hydrateConversationState(saved,{});
  assert.equal(restored.roleCardVersion,st.roleCardVersion);
  assert.equal(hydrateConversationState({...saved,roleCardVersion:'untrusted marker'},{}).roleCardVersion,'');
  assert.equal(JSON.stringify(saved).includes('# 角色卡'),false);
});
test('acceptance records the delivered role version even when the file changes during submission',async()=>{
  const {h,key,st}=await fixture();
  try{
    let delivered;
    h.api.sessions.prompt=async params=>{
      delivered=params.content[0].text;
      fs.appendFileSync(path.join(h.temp,'roles/测试角色.md'),'\n提交期间更新的新卡。');
      return {result:{ok:true,value:{}}};
    };
    await h.deliverPrompt(key,'discarded',{wakeReason:'replyCheck'});
    assert.equal(st.roleCardVersion,/【角色卡版本】([a-f0-9]{16})/.exec(delivered)[1]);
    assert.equal((await h.buildWakePromptV2(key,'replyCheck')).includes('提交期间更新的新卡'),true);
  }finally{await h.close();}
});
test('a stale accepted submission cannot mark a replacement session as having the new role',async()=>{
  const {h,key,st}=await fixture();
  try{
    h.api.sessions.prompt=async()=>{h.state.sessions[key]='replacement-session';return {result:{ok:true,value:{}}};};
    await h.deliverPrompt(key,'discarded',{wakeReason:'replyCheck'});
    assert.equal(st.roleCardInjected,false);assert.equal(st.roleCardVersion,'');
  }finally{await h.close();}
});
