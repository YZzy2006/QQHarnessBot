import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const success=value=>({result:{ok:true,value}});
async function fixture(running=false) {
  const h=await bridgeHarness();h.setMode('reserved2');const key='group:456';
  h.cfg.allow.groups=['456'];const sid=await h.ensureSession(key);
  h.api.sessions.list=async()=>success({items:[{sessionId:sid,running}]});
  return {h,key,sid,st:h.getSocialV2State(key)};
}
test('historical unclosed turns do not restore busy when DSH reports idle',async()=>{
  const {h,key,sid,st}=await fixture(false);
  try {
    await h.rebuildInFlightCollector(sid,[{type:'turn/start',data:{turn:1}}]);
    assert.equal(h.isConversationBusyV2(key,st),false);assert.equal(h.collectors.has(sid),false);
  }finally{await h.close();}
});
test('live DSH turns still restore collectors after reconnect',async()=>{
  const {h,sid}=await fixture(true);
  try {await h.rebuildInFlightCollector(sid,[{type:'turn/start',data:{turn:1}}]);assert.equal(h.collectors.has(sid),true);}
  finally{await h.close();}
});
test('manual wake clears idle phantom busy and submits once without archiving or losing unread',async()=>{
  const {h,key,sid,st}=await fixture(false);
  try {
    h.collectors.set(sid,{});h.collectorStartedAt.set(sid,Date.now()-20*60000);h.v2TurnStartAt.set(sid,Date.now()-20*60000);h.pendingWakeKeys.add(key);
    h.appendSocialV2Message(key,'群友','问题','问题',true,false,'1234',[],234);
    const unread=JSON.stringify(st.unread);
    const results=await Promise.all([h.sendWakePromptV2(key,'proactiveCheck',{manual:true}),h.sendWakePromptV2(key,'proactiveCheck',{manual:true})]);
    assert.ok(results.every(r=>r.ok));assert.equal(h.calls.prompts.length,1);assert.equal(h.calls.archived.length,0);assert.equal(h.calls.cancelled.length,0);assert.equal(JSON.stringify(st.unread),unread);
  }finally{await h.close();}
});
test('manual wake during a real turn queues once and survives all unread being acknowledged',async()=>{
  const {h,key,sid,st}=await fixture(true);
  try {
    h.v2TurnStartAt.set(sid,Date.now());h.turnLastActivityAt.set(sid,Date.now());
    const a=await h.sendWakePromptV2(key,'proactiveCheck',{manual:true});const b=await h.sendWakePromptV2(key,'proactiveCheck',{manual:true});
    assert.equal(a.queued,true);assert.equal(b.queued,true);assert.equal(h.calls.prompts.length,0);assert.equal(st.pendingWakeReasons.filter(v=>v.reason==='manualWake').length,1);
    h.v2TurnStartAt.delete(sid);h.turnLastActivityAt.delete(sid);st.unread=[];
    h.drainPendingWakesV2(key);assert.equal(st.pendingWakeReason,'manualWake');assert.ok(st.pendingWakeTimer);
    assert.equal(h.calls.cancelled.length,0);
  }finally{await h.close();}
});
test('unknown runtime status does not clear busy or duplicate delivery',async()=>{
  const {h,key,sid,st}=await fixture(false);
  try {
    h.api.sessions.list=async()=>{throw Error('offline')};h.collectors.set(sid,{});
    const r=await h.sendWakePromptV2(key,'proactiveCheck',{manual:true});
    assert.equal(r.queued,true);assert.equal(h.collectors.has(sid),true);assert.equal(h.calls.prompts.length,0);assert.equal(st.pendingWakeReasons.length,1);
  }finally{await h.close();}
});
test('manual recovery does not migrate to a replaced session during runtime check',async()=>{
  const {h,key,sid}=await fixture(false);let release,started;
  const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{started=r;});
  try {
    h.collectors.set(sid,{});h.api.sessions.list=async()=>{started();await gate;return success({items:[{sessionId:sid,running:false}]});};
    const pending=h.sendWakePromptV2(key,'proactiveCheck',{manual:true});await seen;h.state.sessions[key]='replacement';release();
    const r=await pending;assert.equal(r.skipped,true);assert.equal(h.calls.prompts.length,0);assert.equal(h.getSocialV2State(key).pendingWakeReasons.length,0);
  }finally{release();await h.close();}
});
test('manual wake preserves a prompt submission already in progress',async()=>{
  const {h,key,sid,st}=await fixture(false);
  try {
    const entry={running:true,queue:[]};h.promptQueues.set(key,entry);h.pendingWakeKeys.add(key);
    const r=await h.sendWakePromptV2(key,'proactiveCheck',{manual:true});
    assert.equal(r.queued,true);assert.equal(h.promptQueues.get(key),entry);assert.equal(h.calls.prompts.length,0);assert.equal(st.pendingWakeReasons.length,1);
  }finally{await h.close();}
});
test('a new accepted wake during runtime lookup is preserved instead of cleared',async()=>{
  const {h,key,sid,st}=await fixture(false);let release,started;
  const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{started=r;});
  try {
    h.collectors.set(sid,{});h.api.sessions.list=async()=>{started();await gate;return success({items:[{sessionId:sid,running:false}]});};
    const pending=h.sendWakePromptV2(key,'proactiveCheck',{manual:true});await seen;h.pendingWakeKeys.add(key);st.wakeConfig.lastWakeAt=Date.now();release();
    const r=await pending;assert.equal(r.queued,true);assert.equal(h.pendingWakeKeys.has(key),true);assert.equal(h.calls.prompts.length,0);
  }finally{release();await h.close();}
});
