import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{requestBilibiliText}from'../src/bilibili-text.js';
test('角色辅助使用配置提供方，不注册工具；工具请求或截断响应拒绝',async()=>{
 const q={kind:'keywords',system:'CURRENT_FULL_CARD',facts:{}};let body;
 const args={q,provider:'deepseek-official',model:'deepseek-flash',effort:'high',apiKey:'fixture',fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return Response.json({choices:[{message:{content:'{"keywords":["游戏"]}'}}]});}};
 await requestBilibiliText(args);assert.equal(body.model,'deepseek-flash');assert.equal(body.tools,undefined);assert.match(body.messages[0].content,/CURRENT_FULL_CARD/);
 await assert.rejects(requestBilibiliText({...args,provider:'other'}),/提供方/);
 for(const choice of [{finish_reason:'length',message:{content:'partial'}},{message:{content:'x',tool_calls:[{}]}}]){
  await assert.rejects(requestBilibiliText({...args,fetchImpl:async()=>Response.json({choices:[choice]})}),/完整|工具/);
 }
});
test('桥接注入运行时完整卡片、预设及发送队列，不引用周记或默认人格',()=>{
 const s=fs.readFileSync(new URL('../src/bridge.js',import.meta.url),'utf8');
 assert.match(s,/createBilibiliBridge/);assert.match(s,/getRoleSnapshot:[\s\S]*currentRoleHintV2\(\)/);
 const start=s.indexOf('const bilibili = createBilibiliBridge'),end=s.indexOf('utilities = createUtilities',start),block=s.slice(start,end);
 assert.match(block,/readPresetPromptText/);assert.match(block,/send:sendUtilityMessage/);assert.doesNotMatch(block,/ownerFacts|ownerTools\.readOwner|persona.*樱良|whale-diary/);
 assert.match(s,/resolveBilibili:bilibili.resolveBilibili/);
});
