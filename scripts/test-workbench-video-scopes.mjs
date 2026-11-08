import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBilibiliState} from '../src/bilibili-state.js';
import {createBilibiliController} from '../src/bilibili-controller.js';
import {createWorkbenchSettings} from '../src/workbench-settings.js';
function fixture(t, options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-video-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let at=Date.UTC(2026,10,8,12);const now=()=>at;
 const state=createBilibiliState({stateDir:dir,now,...options});
 const cfg={ownerQQ:12345,allow:{private:[12345,23456],groups:[34567]}};
 const settings=createWorkbenchSettings({getConfig:()=>cfg,states:()=>new Map(),getState:()=>{throw Error('must not create conversation');},saveStates:()=>{throw Error('must not save conversation');},persist:()=>{throw Error('must not touch config');},voiceProfiles:()=>[],defaultVoice:()=>'',videoState:state,getVideoTargets:()=>['private:12345'],now});
 const row=key=>settings.read().scopes.find(r=>r.key===key);
 const change=(key,action,values)=>settings.update(action,{key,revision:row(key).revision,...values});
 return {state,cfg,row,change,settings,now,advance:n=>at+=n,dir};
}
test('只读投影不落盘，旧会话默认值保留；开关只修改目标视频设置',async t=>{
 const f=fixture(t);assert.equal(fs.existsSync(f.state.file),false);assert.equal(f.row('private:12345').video.effectiveLimit,1);assert.equal(f.row('group:34567').video.effectiveLimit,3);
 await f.change('private:23456','scope.video',{enabled:true});const s=f.state.read();assert.equal(s.targets['private:23456'].enabled,true);assert.equal(s.targets['private:23456'].manualSelect,true);assert.equal(s.targets['private:23456'].schedule,'daily');assert.equal(f.row('private:23456').video.selected,true);assert.equal(s.targets['group:34567'],undefined);
 await f.change('private:23456','scope.video',{enabled:false});assert.equal(f.row('private:23456').video.enabled,false);
});
test('逐会话限额参与真实预留；0暂停、跟随默认、失败释放与手动分享保持',async t=>{
 const f=fixture(t),key='group:34567';await f.change(key,'scope.video-limit',{dailyLimit:1});
 const reserve=(bvid,automatic=true)=>f.state.reserveShare({sourceKey:key,bvid,automatic});
 const failed=reserve('BV1100100004');f.state.finishShare(failed,false);assert.equal(f.row(key).video.used,0);
 const pending=reserve('BV1100100005');assert.equal(f.row(key).video.used,1);assert.throws(()=>reserve('BV1100100006'),/额度/);
 await f.change(key,'scope.video-limit',{dailyLimit:0});assert.equal(f.row(key).video.used,1);assert.throws(()=>reserve('BV1100100006'),/额度/);assert.ok(reserve('BV1100100006',false));
 await f.change(key,'scope.video-limit',{dailyLimit:null});assert.equal(f.state.shareLimit(key),3);assert.equal(f.state.target(key).dailyLimit,undefined);assert.equal(f.row(key).video.used,1);assert.ok(pending);
 const reloaded=createBilibiliState({stateDir:f.dir,now:f.now});assert.equal(reloaded.shareCount(key),1);
 f.advance(16*3600000);assert.equal(f.row(key).video.used,0);
});
test('拒绝过期版本、未知目标、无效数值、任意字段与停用会话',async t=>{
 const f=fixture(t),key='private:23456',old=f.row(key).revision;
 await f.change(key,'scope.video-limit',{dailyLimit:2});await assert.rejects(f.settings.update('scope.video',{key,revision:old,enabled:true}),/变化/);
 for(const dailyLimit of [-1,101,1.5,'2',NaN])await assert.rejects(f.change(key,'scope.video-limit',{dailyLimit}),/整数/);
 await assert.rejects(f.change(key,'scope.video',{enabled:'false'}),/开关/);
 await assert.rejects(f.change(key,'scope.video',{enabled:true,extra:'bad'}),/字段/);
 await assert.rejects(f.settings.update('scope.video',{key:'group:99999',revision:old,enabled:true}),/管理列表/);
 f.cfg.deny={private:[23456]};await assert.rejects(f.change(key,'scope.video',{enabled:true}),/先启用/);
});
test('原QQ全局限额调整使旧表单失效；独立限额不受默认值覆盖',async t=>{
 const f=fixture(t),key='private:23456';await f.change(key,'scope.video-limit',{dailyLimit:4});const old=f.row(key).revision;
 f.state.update(s=>{s.limits.privateDaily=2;},{settings:true});assert.equal(f.row(key).video.effectiveLimit,4);assert.equal(f.row('private:12345').video.effectiveLimit,2);
 await assert.rejects(f.settings.update('scope.video',{key,revision:old,enabled:true}),/变化/);
});
test('写盘失败保留原始设置；损坏的独立限额拒绝读取',async t=>{
 const f=fixture(t,{atomicWrite:()=>{throw Error('disk failure');}});await assert.rejects(f.change('private:23456','scope.video-limit',{dailyLimit:2}),/disk failure/);assert.equal(fs.existsSync(f.state.file),false);
 const g=fixture(t);await g.change('private:23456','scope.video-limit',{dailyLimit:2});const s=g.state.read();s.targets['private:23456'].dailyLimit='oops';fs.writeFileSync(g.state.file,JSON.stringify(s));assert.throws(()=>g.settings.read(),/损坏/);
});
test('手动开启可越过自动目标筛选；关闭与降低限额使在途授权失效且不补发',async t=>{
 const f=fixture(t),key='private:23456';f.state.update(s=>{s.autoSelect=true;});await f.change(key,'scope.video',{enabled:true});
 let authorization,calls=0;const controller=createBilibiliController({state:f.state,now:f.now,ownerQQ:()=>12345,isEnabled:()=>true,isAllowed:()=>true,canNotify:()=>true,getProactiveTargets:()=>['private:12345'],login:{status:()=>({loggedIn:true})},getRoleSnapshot:()=>({version:'v1'}),browse:async(ctx,o)=>{calls++;authorization=o.authorize;assert.equal(o.authorize(),true);}});
 f.state.update(s=>{s.targets[key].plan={day:'2026-11-08',slots:[f.now()-1000],cursor:0};});await controller.tick();assert.equal(calls,1);assert.equal(authorization(),true);
 await f.change(key,'scope.video-limit',{dailyLimit:0});assert.equal(authorization(),false);await controller.tick();assert.equal(calls,1);
 await f.change(key,'scope.video',{enabled:false});await controller.tick();assert.equal(calls,1);assert.equal(f.state.target(key).enabled,false);
});
