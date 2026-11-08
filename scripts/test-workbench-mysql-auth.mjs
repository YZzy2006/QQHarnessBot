import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createMysqlWorkbenchIdentity,loadWorkbenchMysqlIdentity} from '../src/workbench-mysql-auth.js';
import {createWorkbenchAuth} from '../src/workbench-auth.js';
import {setWorkbenchAccount} from '../src/workbench-auth.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {once} from 'node:events';
import path from 'node:path';
const require = createRequire(new URL('../.workbench-deps/package.json',import.meta.url));
const bcrypt = require('bcryptjs');
const password = 'fixture-password-123456789';
const hash = await bcrypt.hash(password,4);
function fixture(overrides={}) {
  const row = {id:'1001000070993',username:'fixture_user',password_hash:hash,enabled:1,workbench_enabled:1,lock_until:null,account_locked:0,...overrides};
  const calls=[];
  const pool={async execute(options,args){calls.push({options,args});assert.equal(args.length,1);assert.match(options.sql,/WHERE (?:id|username) = \? LIMIT 1$/);assert.ok(!options.sql.includes(String(args[0])));return [[args[0]===row.id || args[0]===row.username ? {...row}:null].filter(Boolean)];}};
  const fastBcrypt={hash:async text=>bcrypt.hash(text,4),compare:bcrypt.compare};
  const identity=createMysqlWorkbenchIdentity({pool,bcrypt:fastBcrypt});
  return {row,calls,pool,identity};
}
test('真实bcrypt验证及超大数据库ID；响应只包含身份和版本摘要',async()=>{
  const f=fixture(), a=await f.identity.authenticate('fixture_user',password);
  assert.equal(a.id,'1001000070993');assert.equal(a.username,'fixture_user');assert.match(a.revision,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(a),/password_hash|\$2|isolated/);
  assert.equal(f.calls.length,2);
});
test('兼容博客BCrypt的2a与2y前缀',async()=>{
  for(const prefix of ['$2a$','$2y$']){const f=fixture({password_hash:prefix+hash.slice(4)});assert.equal((await f.identity.authenticate('fixture_user',password)).username,'fixture_user');}
});
test('密码错误、未开通、禁用、锁定及未知用户名均拒绝',async()=>{
  for(const overrides of [{enabled:0},{workbench_enabled:0},{account_locked:1},{password_hash:'invalid'}]){
    const f=fixture(overrides);await assert.rejects(f.identity.authenticate('fixture_user',password),{statusCode:401});
  }
  const f=fixture();await assert.rejects(f.identity.authenticate('fixture_user','wrong'),{statusCode:401});
  await assert.rejects(f.identity.authenticate('missing',password),{statusCode:401});
});
test('SQL注入字符串作为绑定参数；不拼接为SQL',async()=>{
  const f=fixture();await assert.rejects(f.identity.authenticate("x' OR 1=1 --",password),{statusCode:401});
  assert.equal(f.calls[0].args[0],"x' OR 1=1 --");
});
test('数据库错误隐藏连接信息，配置后不退回本地账号',async()=>{
  const identity=createMysqlWorkbenchIdentity({pool:{execute:async()=>{throw Error('secret database credentials');}},bcrypt});
  await assert.rejects(identity.authenticate('fixture_user',password),e=>e.statusCode===503&&!e.message.includes('secret'));
  const auth=createWorkbenchAuth({stateDir:'/does-not-exist',identity});
  await assert.rejects(auth.login('fixture_user',password,'test'),{statusCode:503});
});
test('权限撤销、账号锁定与密码变化即时使已有Cookie失效',async()=>{
  for(const mutation of [r=>r.workbench_enabled=0,r=>r.enabled=0,r=>r.account_locked=1,r=>r.password_hash=hash.replace('$04$','$05$')]){
    const f=fixture(), auth=createWorkbenchAuth({stateDir:'/no-local-account',identity:f.identity});
    const {token}=await auth.login('fixture_user',password,'test');const req={headers:{cookie:'qq_workbench='+token}};
    assert.ok(await auth.session(req));mutation(f.row);assert.equal(await auth.session(req),null);
  }
});
test('验证密码期间撤销权限不能发出登录会话',async()=>{
  const f=fixture();const identity=createMysqlWorkbenchIdentity({pool:f.pool,bcrypt:{hash:async()=>hash,compare:async()=>{f.row.workbench_enabled=0;return true;}}});
  await assert.rejects(identity.authenticate('fixture_user',password),{statusCode:401});
});
test('数据库会话保持12小时到期、退出和HttpOnly/Secure Cookie',async()=>{
  const f=fixture();let clock=100000;const auth=createWorkbenchAuth({stateDir:'/no-local-account',identity:f.identity,now:()=>clock});
  const {token}=await auth.login('fixture_user',password,'test');const req={headers:{cookie:'qq_workbench='+token}};
  assert.ok(await auth.session(req));assert.match(auth.cookie(token,true),/HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  clock+=43200001;assert.equal(await auth.session(req),null);
  const next=await auth.login('fixture_user',password,'test');const req2={headers:{cookie:'qq_workbench='+next.token}};
  auth.logout(req2);assert.equal(await auth.session(req2),null);
});
test('不截断超过72字节的BCrypt密码；身份字段和ID边界校验',async()=>{
  const f=fixture();await assert.rejects(f.identity.authenticate('fixture_user','中'.repeat(25)),{statusCode:401});
  assert.equal(await f.identity.account('1 OR 1=1'),null);assert.equal(f.calls.length,0);
});
test('显式数据库配置不可读时失败关闭，未配置时保留隔离预览',async()=>{
  const previous=process.env.QQ_WORKBENCH_DB_FILE;
  try{delete process.env.QQ_WORKBENCH_DB_FILE;assert.equal(loadWorkbenchMysqlIdentity(),null);
    process.env.QQ_WORKBENCH_DB_FILE='/missing-secret-file';const identity=loadWorkbenchMysqlIdentity();
    assert.throws(()=>identity.authenticate('fixture_user',password),{statusCode:503});
  }finally{if(previous===undefined)delete process.env.QQ_WORKBENCH_DB_FILE;else process.env.QQ_WORKBENCH_DB_FILE=previous;}
});
test('真实桥接配置保留公开HTTPS来源，反代登录成功并设置Secure Cookie',async t=>{
  const origin='https://workbench.example.com';
  const h=await bridgeHarness({config:{workbench:{origin}}});
  await setWorkbenchAccount(path.join(h.temp,'state'),'fixture',password);
  const server=h.startConsoleServer();await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();});
  const result=await fetch(`http://127.0.0.1:${server.address().port}/api/workbench/login`,{
    method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'fixture',password})});
  assert.equal(result.status,200);assert.match(result.headers.get('set-cookie'),/; Secure$/);
});
