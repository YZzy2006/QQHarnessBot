import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import{createBilibiliState}from'../src/bilibili-state.js';import{createBilibiliController,mapBilibiliText}from'../src/bilibili-controller.js';
const ctx={sourceKey:'private:123',userId:'123',message:[]};
function setup(t,extra={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-state-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let at=Date.UTC(2026,10,1,13);const sent=[],actions=[];
 const state=createBilibiliState({stateDir:dir,now:()=>at});
 const d={state,now:()=>at,ownerQQ:()=> '123',isAllowed:()=>true,isEnabled:()=>true,canNotify:()=>true,getRoleSnapshot:()=>({version:'v1',name:'card',text:'full'}),
 say:async(c,text)=>sent.push(text),resolveTarget:async raw=>({ok:true,key:raw}),login:{status:()=>({loggedIn:true,account:{name:'a'},commentsEnabled:false})},
 browse:async(c,o)=>actions.push(['browse',c,o]),share:async(c,o)=>actions.push(['share',c,o]),...extra};
 return{state,c:createBilibiliController(d),sent,actions,d,advance:n=>at+=n};}
test('默认1/3/6，管理员私聊可调，群内/非管理员拒绝全局限额',async t=>{
 const f=setup(t);assert.deepEqual(f.state.read().limits,{privateDaily:1,groupDaily:3,browseDaily:6});
 await f.c.handle(ctx,'[B站限额][私聊主动][4]');assert.equal(f.state.read().limits.privateDaily,4);
 for(const v of ['-1','1.5','7','101'])await f.c.handle(ctx,'[B站限额][每日浏览]['+v+']');
 assert.equal(f.state.read().limits.browseDaily,6);
 await f.c.handle({...ctx,sourceKey:'group:456'},'[B站限额][每日浏览][4]');assert.equal(f.state.read().limits.browseDaily,6);
 await f.c.handle({...ctx,userId:'999'},'[B站限额][每日浏览][4]');assert.equal(f.state.read().limits.browseDaily,6);
});
test('6次深读含失败尝试；每目标主动1/3，手动分享不计主动；未知发送持久抑制重发',async t=>{
 const f=setup(t);for(let i=0;i<6;i++)f.state.reserveRead({bvid:'BV123456789'+i,roleVersion:'v1'});
 assert.throws(()=>f.state.reserveRead({bvid:'BVaaaaaaaaaa',roleVersion:'v1'}),/浏览.*额度/);
 for(let i=0;i<1;i++){const j=f.state.reserveShare({sourceKey:'private:123',bvid:'BV123456789'+i,automatic:true});f.state.finishShare(j,true);}
 assert.throws(()=>f.state.reserveShare({sourceKey:'private:123',bvid:'BVbbbbbbbbbb',automatic:true}),/分享.*额度/);
 const manual=f.state.reserveShare({sourceKey:'private:123',bvid:'BVbbbbbbbbbb',automatic:false});f.state.finishShare(manual,true);
 const pending=f.state.reserveShare({sourceKey:'group:456',bvid:'BVcccccccccc',automatic:true});
 assert.ok(pending);assert.equal(f.state.wasShared('group:456','BVcccccccccc'),true);
 assert.equal(createBilibiliState({stateDir:path.dirname(path.dirname(f.state.file)),now:()=>Date.UTC(2026,10,1,13)}).wasShared('group:456','BVcccccccccc'),true);
});
test('私聊显式转发目标，开启及调频不误发，自动调度不补多轮',async t=>{
 const f=setup(t);await f.c.handle(ctx,'[分享B站][BV1100100004][group:456]');
 assert.equal(f.actions[0][2].targetKey,'group:456');assert.equal(f.actions[0][2].automatic,false);
 await f.c.handle(ctx,'[B站频率][30][group:456]');assert.equal(f.state.read().targets['group:456'].enabled,false);
 await f.c.handle(ctx,'[B站浏览][开启][group:456]');f.advance(31*60000);await f.c.tick();
 assert.equal(f.actions.filter(v=>v[0]==='browse').length,1);await f.c.tick();assert.equal(f.actions.filter(v=>v[0]==='browse').length,1);
});
test('关闭或切卡会令在途授权失效；目标白名单变动即停止',async t=>{
 let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);let auth;
 const f=setup(t,{browse:async(c,o)=>{auth=o.authorize;entered();await gate;assert.equal(auth(),false);}});
 const work=f.c.handle(ctx,'[刷B站]');await start;await f.c.handle(ctx,'[B站浏览][关闭]');release();await work;
});
test('损坏状态拒绝读取，不用默认覆盖',async t=>{
 const f=setup(t);fs.mkdirSync(path.dirname(f.state.file),{recursive:true});fs.writeFileSync(f.state.file,'broken');
 assert.throws(()=>f.state.read(),/损坏/);assert.equal(fs.readFileSync(f.state.file,'utf8'),'broken');
});


test('管理员私聊单括号/分括号分享视频与观看视频，目标类型和刷B站定向',async t=>{
 const f=setup(t,{watch:async(c,o)=>f.actions.push(['watch',c,o]),resolveTarget:async raw=>({ok:true,key:raw==='游戏群'?'group:456':'private:234'})});
 for(const raw of ['[分享视频 BV1100100004 group:456]','[分享视频][BV1100100004][群456]','[分享视频][BV1100100004][游戏群]','[观看视频 BV1100100004 私聊234]','[刷B站 group:456]'])assert.equal(await f.c.handle(ctx,raw),true,raw);
 assert.deepEqual(f.actions.map(v=>[v[0],v[2].targetKey]),[['share','group:456'],['share','group:456'],['share','group:456'],['watch','private:234'],['browse','group:456']]);
 await f.c.handle(ctx,'[观看视频 BV1100100004]');assert.equal(f.actions.at(-1)[2].targetKey,'private:123');
 assert.ok(f.sent.some(v=>v.includes('private:234')));
});
test('非管理员/管理员群内/伪造私聊来源拒绝新视频控制，撤权和歧义不读取',async t=>{
 const f=setup(t,{isAllowed:k=>k!=='group:999',watch:()=>{throw Error('must not watch');},resolveTarget:async()=>({ok:false,message:'目标有歧义，请用号码'})});
 for(const context of [{...ctx,userId:'234'},{...ctx,sourceKey:'group:456'},{...ctx,sourceKey:'private:234'}]){
  for(const name of ['分享视频','观看视频'])assert.equal(await f.c.handle(context,'['+name+' BV1100100004 group:456]'),true);
 }
 await f.c.handle(ctx,'[分享视频 BV1100100004 group:999]');await f.c.handle(ctx,'[分享视频 BV1100100004 重名]');
 assert.equal(f.actions.length,0);assert.match(f.sent.join(' '),/管理员/);assert.match(f.sent.join(' '),/白名单/);assert.match(f.sent.join(' '),/歧义/);
 await f.c.handle({...ctx,sourceKey:'group:456'},'[分享B站 BV1100100004 private:234]');assert.equal(f.actions.length,0);
});
test('分享/观看视频自然写法明确给目标，引用教学不触发',()=>{
 assert.deepEqual(mapBilibiliText('分享视频 BV1100100004 给 游戏群'),{command:'分享视频',args:['BV1100100004','游戏群']});
 assert.deepEqual(mapBilibiliText('观看视频 BV1100100004'),{command:'观看视频',args:['BV1100100004']});
 assert.equal(mapBilibiliText('他说分享视频 BV1100100004 给 游戏群'),null);
});


test('电脑/手机复制标题和跟踪链接自动提取，保留分P及末尾目标',async t=>{
 const f=setup(t,{watch:async(c,o)=>f.actions.push(['watch',c,o]),resolveTarget:async raw=>({ok:true,key:raw==='200000001'?'group:456':raw})});
 const url='https://www.bilibili.com/video/BV1gAxv6JEp4/?share_source=copy_web&vd_source=fixture';
 for(const raw of ['[分享视频 【菲比讨伐大肥鱼】 '+url+' 200000001]','[分享视频 【菲比 [标题]】\n'+url+' group:456]','[分享视频][【手机端标题】 https://b23.tv/fixture][group:456]','观看视频 【教程“视频”】 https://www.bilibili.com/video/BV1gAxv6JEp4/?p=2&share_source=copy_web group:456']){
  assert.equal(await f.c.handle(ctx,raw),true,raw);
 }
 assert.equal(f.actions.length,4);assert.equal(f.actions[0][2].input,'https://www.bilibili.com/video/BV1gAxv6JEp4');assert.equal(f.actions[2][2].input,'https://b23.tv/fixture');assert.equal(f.actions[3][2].input,'https://www.bilibili.com/video/BV1gAxv6JEp4?p=2');assert.ok(f.actions.every(v=>v[2].targetKey==='group:456'));
});
test('引用卡片可简单说分享到/发给，也可单参数分享；无引用不拦截普通话',async t=>{
 const f=setup(t,{recentVideo:async c=>{assert.equal(c.quotedId,'77');return'https://www.bilibili.com/video/BV1gAxv6JEp4';}}),q={...ctx,quotedId:'77'};
 for(const raw of ['分享到group:456','分享给 group:456','把这个视频发到 group:456','[分享视频 group:456]'])assert.equal(await f.c.handle(q,raw),true,raw);
 assert.equal(f.actions.length,4);assert.ok(f.actions.every(v=>v[2].input.includes('BV1gAxv6JEp4')&&v[2].targetKey==='group:456'));
 assert.equal(await f.c.handle(ctx,'发给group:456'),false);
});
test('复制文本多个链接拒绝，引用失败不猜最近视频，权限仍先检查',async t=>{
 let reads=0;const f=setup(t,{recentVideo:async()=>{reads++;throw Error('引用不属于当前会话');}});
 await f.c.handle(ctx,'[分享视频 【标题】 https://b23.tv/a https://b23.tv/b group:456]');assert.equal(f.actions.length,0);assert.match(f.sent.at(-1),/一个|多/);
 await f.c.handle({...ctx,quotedId:'77'},'分享到group:456');assert.equal(reads,1);assert.equal(f.actions.length,0);assert.match(f.sent.at(-1),/引用/);
 await f.c.handle({...ctx,userId:'234',quotedId:'77'},'分享到group:456');assert.equal(reads,1);
});


test('已验证发送的卡片原视频引用按会话/消息ID持久化，过期与损坏拒绝借用',async t=>{
 const f=setup(t);f.state.rememberCard({sourceKey:'private:123',messageId:-77,url:'https://www.bilibili.com/video/BV1100100004?p=2'});
 const reloaded=createBilibiliState({stateDir:path.dirname(path.dirname(f.state.file)),now:()=>Date.UTC(2026,10,1,13)});assert.equal(reloaded.cardReference('private:123',-77).url,'https://www.bilibili.com/video/BV1100100004?p=2');assert.equal(reloaded.cardReference('group:456',-77),null);assert.equal(reloaded.cardReference('private:123',88),null);f.advance(8*86400000);assert.equal(f.state.cardReference('private:123',-77),null);const bad=f.state.read();bad.cards[0].url='https://example.com/';fs.writeFileSync(f.state.file,JSON.stringify(bad));assert.throws(()=>f.state.cardReference('private:123',-77),/损坏/);
});
