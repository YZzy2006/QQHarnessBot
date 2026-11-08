import {test} from 'node:test';import assert from 'node:assert/strict';
import {selectBilibiliTargets,dailyBilibiliPlan} from '../src/bilibili-proactive.js';
import {createBilibiliController} from '../src/bilibili-controller.js';
const now=Date.UTC(2026,10,2,12);
test('只选本人、48h内来信最多的至多两位和白名单群，排除自身消息/重复/过期/撤权',()=>{
 const make=(n,old=false)=>({recentMessages:Array.from({length:n},(_,i)=>({messageId:i,time:now-(old?49:1)*3600000,userId:'',isSelf:false})),unread:[]});
 const conversations={'private:234':make(3),'private:345':make(8),'private:456':make(5),'private:567':make(10,true),'private:678':make(100)};
 conversations['private:345'].unread=[...conversations['private:345'].recentMessages];
 assert.deepEqual(selectBilibiliTargets({ownerQQ:123,privateIds:[123,234,345,456,567,678],groupIds:[999],conversations,isAllowed:k=>k!=='private:678',now}),['group:999','private:123','private:345','private:456']);
 assert.deepEqual(selectBilibiliTargets({ownerQQ:123,privateIds:[234],groupIds:[999],conversations:{},isAllowed:()=>true,now}),['group:999','private:123']);
});
test('每日随机私聊0–1/群1–3，窗口分散至少60分钟，晚启不排过去时点',()=>{
 const t={start:20,end:24};for(const draw of [0,.7,.95]){
  const g=dailyBilibiliPlan('group:999',t,{now,random:()=>draw,limit:3});assert.equal(g.slots.length,draw<.6?1:draw<.9?2:3);
  for(let i=1;i<g.slots.length;i++)assert.ok(g.slots[i]-g.slots[i-1]>=3600000);
  assert.ok(g.slots.every(x=>x>=now&&x<now+4*3600000));
 }
 assert.equal(dailyBilibiliPlan('private:123',t,{now,random:()=>.1}).slots.length,0);
 assert.equal(dailyBilibiliPlan('private:123',t,{now,random:()=>.9}).slots.length,1);
 const late=dailyBilibiliPlan('group:999',t,{now:now+3.5*3600000,random:()=>.95});assert.equal(late.slots.length,1);
});
test('额度前置和群首条优先，停机多时点只取一次，已消费计划重启不补发',async()=>{
 const v={revision:0,limits:{browseDaily:6,privateDaily:1,groupDaily:3},targets:{'private:123':{enabled:true,interval:180,start:20,end:24,dueAt:0},'group:999':{enabled:true,schedule:'daily',interval:180,start:20,end:24,dueAt:0,plan:{day:'2026-11-02',slots:[now-1000,now-500],cursor:0}}}};
 const calls=[],state={read:()=>v,update:fn=>fn(v),readCount:()=>0,shareCount:k=>k.startsWith('private:')?1:0,shareLimit:k=>k.startsWith('private:')?1:3};
 const args={state,now:()=>now,ownerQQ:()=>123,isEnabled:()=>true,isAllowed:()=>true,canNotify:()=>true,login:{status:()=>({loggedIn:true})},getRoleSnapshot:()=>({version:'v1'}),browse:async c=>calls.push(c.sourceKey)};
 await createBilibiliController(args).tick();assert.deepEqual(calls,['group:999']);assert.equal(v.targets['group:999'].plan.cursor,2);
 await createBilibiliController(args).tick();assert.equal(calls.length,1);
});
