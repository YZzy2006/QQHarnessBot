import {parseQzoneCommentApprovalIntent} from '../src/qzone-social.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WORKBENCH_OPERATIONS as specs,buildWorkbenchOperation,publicOperations} from '../src/workbench-operations.js';
import {projectWorkbenchContacts} from '../src/workbench-contacts.js';
import {parseOwnerToolsCommand} from '../src/owner-tools.js';
import {parseOwnerConsoleCommand} from '../src/owner-console.js';
import {parseOwnerActionCommand} from '../src/owner-actions.js';
import {parseOwnerExtraCommand} from '../src/owner-extra.js';
import {parseOwnerInspectCommand} from '../src/owner-inspect.js';
import {parseWhitelistCommand} from '../src/whitelist-commands.js';
import {parseAdminCommand} from '../src/admin-actions.js';
import {parseQzoneFeedQuery,parseQzoneFeedAction} from '../src/qzone-feed-query.js';
import {parseProfileLikeCommand} from '../src/qzone-profile-like.js';
import {parseFriendRequestCommand} from '../src/friend-requests.js';
import {parseFriendViewCommand} from '../src/friend-views.js';
import {parseGroupViewCommand} from '../src/group-views.js';
const allowed=['private:12345','private:23456','group:34567'];
const parsers=[parseQzoneCommentApprovalIntent,parseOwnerConsoleCommand,parseOwnerActionCommand,parseOwnerExtraCommand,parseOwnerInspectCommand,parseWhitelistCommand,parseAdminCommand,parseQzoneFeedQuery,parseQzoneFeedAction,parseProfileLikeCommand,parseFriendRequestCommand,parseFriendViewCommand,parseGroupViewCommand];
const sample=spec=>Object.fromEntries(spec.fields.map(f=>{
 let value=f.value||'测试';
 if(f.type==='target')value=f.kind==='group'?'group:34567':'private:23456';
 if(f.type==='ref')value=spec.id==='task.cancel'||spec.id==='console.cancel-reminder'?'r_123456789abc':'1';
 if(spec.id.startsWith('tools.note-')&&f.name==='id')value='n_123456789a';
 if(f.type==='ids')value='23456,34567';
 if(f.name==='range'&&!f.value)value='最近100条';
 if(f.name==='condition')value='连续7天';
 return [f.name,value];
}));
test('13组结构化操作覆盖，所有生成的非API指令都能被原解析器识别',()=>{
 assert.equal(new Set(specs.map(s=>s.id)).size,specs.length);
 assert.deepEqual([...new Set(specs.map(s=>s.group))].sort((a,b)=>a-b),Array.from({length:13},(_,i)=>i+1));
 const failed=[];
 for(const spec of specs){
  const built=buildWorkbenchOperation(spec.id,sample(spec),true,allowed);
  if(built.endpoint)continue;
  if(spec.format==='qzone'){assert.match(built.command,/^\/qzone (?:status|social|list|draft|approve|reject|reconcile|on|off|auto|right|undo)(?: |$)/);continue;}
  const owner=parseOwnerToolsCommand(built.command);
  if(owner?.command)continue;
  if(!parsers.some(parse=>{try{return parse(built.command)?.ok===true;}catch{return false;}}))failed.push(spec.id+': '+built.command);
 }
 assert.deepEqual(failed,[]);
 assert.ok(publicOperations().every(s=>!Object.hasOwn(s,'tokens')));
});
test('未知操作、额外参数、指令注入、错误目标与未确认写入在执行前拒绝',()=>{
 assert.throws(()=>buildWorkbenchOperation('shell',{},true,allowed),/未知/);
 assert.throws(()=>buildWorkbenchOperation('tools.note',{content:'a',command:'/reset'},true,allowed),/未开放/);
 assert.throws(()=>buildWorkbenchOperation('tools.note',{content:'a][清理磁盘'},true,allowed),/括号/);
 assert.throws(()=>buildWorkbenchOperation('admin.kick',{group:'private:23456',member:'测试'},true,allowed),/类型/);
 assert.throws(()=>buildWorkbenchOperation('tools.note',{content:'记下来'},false,allowed),/确认/);
 assert.throws(()=>buildWorkbenchOperation('active.talk',{target:'private:99999',content:'你好'},true,allowed),/允许/);
 assert.throws(()=>buildWorkbenchOperation('task.cancel',{id:'全部'},true,allowed),/完整 ID/);
 assert.throws(()=>buildWorkbenchOperation('allow.private.set',{ids:'23456,/reset'},true,allowed),/号码/);
});
test('复杂聊天记录明确由原QQ合并转发展示',()=>{
 assert.equal(specs.find(s=>s.id==='friends.history').delivery,'qq');
 assert.equal(specs.find(s=>s.id==='groups.history').risk,'send');
});
test('联系人投影保留昵称备注群名与别名，不投影原始私有字段',()=>{
 const rows=projectWorkbenchContacts({friends:[{user_id:23456,nickname:'测试联系人',remark:'小雨',token:'secret'}],groups:[{group_id:34567,group_name:'读书群',secret:'hidden'}],aliases:[{key:'private:23456',name:'雨雨'}]},['private:12345']);
 const friend=rows.find(r=>r.key==='private:23456');assert.equal(friend.name,'小雨');assert.equal(friend.nickname,'测试联系人');assert.deepEqual(friend.aliases,['雨雨']);
 assert.equal(rows.find(r=>r.key==='group:34567').name,'读书群');assert.doesNotMatch(JSON.stringify(rows),/secret|hidden|token/);
});
