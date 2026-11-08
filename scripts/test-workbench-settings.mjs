import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbenchSettings, applyWorkbenchConfigPatch} from '../src/workbench-settings.js';
function fixture(options={}) {
 const config={ownerQQ:12345,allow:{private:[12345,23456],groups:[34567]},deny:{private:[],groups:[]},allowAllWhenEmpty:true,dsh:{model:'chat-fixture',provider:'fixture-provider',authToken:'DO-NOT-EXPOSE'},vision:{model:'vision-fixture',fallbackEnabled:true},socialV2:{enabled:true,tools:{generateImage:true,unrelated:false},voice:{defaultProfile:'soft',ttsEnabled:true},proactive:{enabled:true,maxIdleDays:3}},unrelated:{keep:42}};
 const sessions=new Map([['group:34567',{voiceProfile:'bright',proactiveGreetingEnabled:true,lastIncomingAt:Date.now(),secret:'DO-NOT-EXPOSE-STATE'}]]);let writes=0,saves=0;
 const voices=[{id:'soft',label:'柔和',model:'tts-fixture',voice:'soft-voice'},{id:'bright',label:'明亮',model:'tts-fixture',voice:'bright-voice'}];
 const settings=createWorkbenchSettings({getConfig:()=>config,states:()=>sessions,getState:key=>{if(!sessions.has(key))sessions.set(key,{});return sessions.get(key);},saveStates:()=>saves++,voiceProfiles:()=>voices,defaultVoice:()=>config.socialV2.voice.defaultProfile,environment:{QWEN_API_KEY:'DO-NOT-EXPOSE-ENV',GAODE_WEB_API_KEY:'DO-NOT-EXPOSE-MAPS'},defaults:{doubaoImageModel:'image-fixture'},status:()=>({dshReady:true,role:'fixture-role'}),persist:async entries=>{if(options.fail)throw Error('disk failure');applyWorkbenchConfigPatch(config,entries);writes++;}});
 return {config,sessions,settings,count:()=>({writes,saves}),row:key=>settings.read().scopes.find(r=>r.key===key)};
}
test('档案只投影能力/声线/服务配置，不初始化会话、不暴露凭据与原始状态',()=>{
 const f=fixture(),size=f.sessions.size,data=f.settings.read();assert.equal(f.sessions.size,size);assert.deepEqual(f.count(),{writes:0,saves:0});
 assert.equal(data.capabilities.find(c=>c.id==='live').configured,false);assert.equal(data.voices.length,2);assert.equal(data.services.find(s=>s.id==='chat').model,'chat-fixture');
 assert.doesNotMatch(JSON.stringify(data),/DO-NOT-EXPOSE|authToken|apiKey|secret/);
});
test('单会话停用保留白名单成员且写入deny，空白名单放行模式不会被扩大',async()=>{
 const f=fixture();await f.settings.update('scope.enabled',{key:'group:34567',enabled:false,revision:f.row('group:34567').revision});
 assert.deepEqual(f.config.allow.groups,[34567]);assert.deepEqual(f.config.deny.groups,[34567]);assert.equal(f.row('group:34567').enabled,false);assert.equal(f.sessions.get('group:34567').secret,'DO-NOT-EXPOSE-STATE');
 await f.settings.update('scope.enabled',{key:'group:34567',enabled:true,revision:f.row('group:34567').revision});assert.equal(f.row('group:34567').enabled,true);assert.deepEqual(f.config.deny.groups,[]);
});
test('保护管理员会话，拒绝越界目标、字符串开关与过期版本',async()=>{
 const f=fixture();await assert.rejects(f.settings.update('scope.enabled',{key:'private:12345',enabled:false,revision:f.row('private:12345').revision}),/管理员/);
 await assert.rejects(f.settings.update('scope.proactive',{key:'group:99999',enabled:true,revision:'bad'}),/管理列表/);
 await assert.rejects(f.settings.update('scope.enabled',{key:'group:34567',enabled:'false',revision:f.row('group:34567').revision}),/布尔/);
 const old=f.row('group:34567').revision;await f.settings.update('scope.proactive',{key:'group:34567',enabled:false,revision:old});await assert.rejects(f.settings.update('scope.voice',{key:'group:34567',profile:'soft',revision:old}),/变化/);
});
test('主动与声线只改选中会话，声线允许恢复默认；未知声线拒绝',async()=>{
 const f=fixture();await f.settings.update('scope.proactive',{key:'group:34567',enabled:false,revision:f.row('group:34567').revision});assert.equal(f.sessions.get('group:34567').proactiveGreetingEnabled,false);assert.equal(f.sessions.has('private:23456'),false);
 await f.settings.update('scope.voice',{key:'group:34567',profile:'soft',revision:f.row('group:34567').revision});assert.equal(f.sessions.get('group:34567').voiceProfile,'');
 await assert.rejects(f.settings.update('scope.voice',{key:'group:34567',profile:'unknown',revision:f.row('group:34567').revision}),/声线/);
});
test('全局仅改明确字段，保留未编辑配置；过期编辑和任意字段不能写入',async()=>{
 const f=fixture(),old=f.settings.read().revision;await f.settings.update('capability.toggle',{id:'voice',enabled:false,revision:old});assert.equal(f.config.socialV2.voice.ttsEnabled,false);assert.equal(f.config.socialV2.tools.unrelated,false);assert.equal(f.config.unrelated.keep,42);
 await assert.rejects(f.settings.update('capability.toggle',{id:'dialogue',enabled:false,revision:old}),/变化/);
 await assert.rejects(f.settings.update('capability.toggle',{id:'voice',enabled:true,revision:f.settings.read().revision,apiKey:'oops'}),/字段/);
 await assert.rejects(f.settings.update('capability.toggle',{id:'__proto__',enabled:true,revision:f.settings.read().revision}),/无效/);
});
test('视觉模型与默认声线保存到实际配置路径，不触发请求；不存在的默认声线拒绝',async()=>{
 const f=fixture();await f.settings.update('service.vision',{model:'vision-new',revision:f.settings.read().revision});assert.equal(f.settings.read().services.find(s=>s.id==='vision').model,'vision-new');
 await f.settings.update('service.voice-default',{profile:'bright',revision:f.settings.read().revision});assert.equal(f.settings.read().defaultVoice,'bright');
 await assert.rejects(f.settings.update('service.voice-default',{profile:'bad',revision:f.settings.read().revision}),/声线/);assert.equal(f.count().saves,0);
});
test('加入私聊/群聊白名单只更新指定列表；输入与配置路径不能逃逸',async()=>{
 const f=fixture();await f.settings.update('scope.add',{kind:'private',id:'45678'});assert.deepEqual(f.config.allow.groups,[34567]);assert.ok(f.config.allow.private.includes(45678));
 await assert.rejects(f.settings.update('scope.add',{kind:'__proto__',id:'45678'}),/QQ号或群号/);assert.throws(()=>applyWorkbenchConfigPatch({},[{path:['__proto__','polluted'],value:1}]),/路径/);assert.equal({}.polluted,undefined);
});
test('配置写失败不改运行态；停用会话不能继续保存主动/声线设置',async()=>{
 const f=fixture({fail:true});await assert.rejects(f.settings.update('capability.toggle',{id:'voice',enabled:false,revision:f.settings.read().revision}),/disk failure/);assert.equal(f.config.socialV2.voice.ttsEnabled,true);
 const g=fixture();await g.settings.update('scope.enabled',{key:'group:34567',enabled:false,revision:g.row('group:34567').revision});await assert.rejects(g.settings.update('scope.voice',{key:'group:34567',profile:'bright',revision:g.row('group:34567').revision}),/先启用/);
});

test('单数group与复数privates旧配置按原准入字段读写，不扩大其他列表',async()=>{
 const f=fixture();f.config.allow={group:[34567],groups:[99999],privates:[12345,23456]};f.config.deny={group:[],groups:[99999],privates:[]};
 assert.ok(f.row('group:34567'));assert.equal(f.row('group:99999'),undefined);
 await f.settings.update('scope.enabled',{key:'group:34567',enabled:false,revision:f.row('group:34567').revision});assert.deepEqual(f.config.deny.group,[34567]);assert.deepEqual(f.config.deny.groups,[99999]);
 await f.settings.update('scope.add',{kind:'private',id:'45678'});assert.ok(f.config.allow.privates.includes(45678));assert.equal(f.config.allow.private,undefined);
});
test('会话写盘失败回退运行态，不留下新建会话或虚假的保存成功',async()=>{
 const f=fixture(),original=structuredClone(f.sessions.get('group:34567'));
 const settings=createWorkbenchSettings({getConfig:()=>f.config,persist:async()=>{},states:()=>f.sessions,getState:key=>{if(!f.sessions.has(key))f.sessions.set(key,{});return f.sessions.get(key);},saveStates:()=>{throw Error('disk failure');},voiceProfiles:()=>[{id:'soft'},{id:'bright'}],defaultVoice:()=> 'soft'});
 const row=key=>settings.read().scopes.find(r=>r.key===key);
 await assert.rejects(settings.update('scope.proactive',{key:'group:34567',enabled:false,revision:row('group:34567').revision}),/disk failure/);assert.deepEqual(f.sessions.get('group:34567'),original);
 await assert.rejects(settings.update('scope.voice',{key:'private:23456',profile:'bright',revision:row('private:23456').revision}),/disk failure/);assert.equal(f.sessions.has('private:23456'),false);
});
test('视频理解能力随真实视觉开关关闭，启用后恢复显示',async()=>{
 const f=fixture();f.config.vision.fallbackEnabled=false;assert.equal(f.settings.read().capabilities.find(c=>c.id==='video').enabled,false);
 f.config.vision.fallbackEnabled=true;assert.equal(f.settings.read().capabilities.find(c=>c.id==='video').enabled,true);
});
