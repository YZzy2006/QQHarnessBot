import {test} from 'node:test';import assert from 'node:assert/strict';
import {MAX_WAIT_MS,MAX_QUIET_MS,WAIT_TAIL_MS,WAIT_HTTP_MARGIN_MS,serverLongPollBudget,longPollClientBudget,consumedPrivateWake} from '../src/wait-budget.js';
test('MCP预算覆盖服务端最长静默尾窗和传输余量，未传timeout时按服务端上限等待',()=>{
 for(const timeout of [5000,30000,300000,600000])assert.ok(longPollClientBudget(timeout)>=timeout+MAX_QUIET_MS+WAIT_TAIL_MS+WAIT_HTTP_MARGIN_MS);
 assert.equal(longPollClientBudget(),MAX_WAIT_MS+MAX_QUIET_MS+WAIT_TAIL_MS+WAIT_HTTP_MARGIN_MS);assert.equal(longPollClientBudget(300000),445000);assert.equal(longPollClientBudget(600000),745000);
});
test('只拦已明确确认且无新数据的自动private原因，不拦新消息和手动/定时',()=>{
 const closed={lastUnreadSeq:7,lastReadThroughSeq:7,unread:[]};assert.equal(consumedPrivateWake(closed,'private'),true);assert.equal(consumedPrivateWake(closed,'private',true),false);assert.equal(consumedPrivateWake(closed,'timeout'),false);
 assert.equal(consumedPrivateWake({...closed,lastReadThroughSeq:6},'private'),false);assert.equal(consumedPrivateWake({...closed,unread:[{seq:8}]},'private'),false);
});

test('服务端尾窗也落在旧客户端预算内，避免为热修复重启正在使用的DSH连接',()=>{
 for(const timeout of [5000,30000,300000,600000])for(const quiet of [0,10000,12000,120000]){
  const server=serverLongPollBudget(timeout,quiet,120000),legacy=Math.min(725000,timeout+Math.max(quiet,10000)+20000);
  assert.ok(legacy-server>=5000);assert.ok(longPollClientBudget(timeout)>server);
 }
});
