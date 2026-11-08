import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {setWorkbenchAccount, createWorkbenchAuth} from '../src/workbench-auth.js';
import {createWorkbenchStore, WORKBENCH_TTL} from '../src/workbench-store.js';
import {createWorkbench, workbenchReply} from '../src/workbench-http.js';
const password = 'fixture-password-12345';
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-workbench-'));
  await setWorkbenchAccount(dir, 'fixture', password);
  let clock = Date.now(); const calls = [];
  const store = createWorkbenchStore({stateDir: dir, now: () => clock});
  const f = {ownerQQ: '123', scopes: ['group:456'], notes: [], memories: [], todos: [], tasks: []};
  const handler = createWorkbench({root: process.cwd(), stateDir: dir, store, now: () => clock, facts: () => f, publicOrigin: options.publicOrigin || '',
    api: async (route, method, body) => {calls.push({route, method, body}); return route === '/api/status' ? {role: 'fixture-role', activity: 'group:456 收到消息\nprivate:123 私人消息', snowluma: {accountOnline: true}} : route === '/api/socialV2/feedback' ? {entries: [{id: 'f-1', key: 'group:456', message: '建议', time: new Date(clock).toISOString()}]} : {ok: true, entries: [], roles: []};},
    execute: options.execute || (async (family, text) => {calls.push({family, text}); await workbenchReply(() => {throw Error('must not send QQ');}, 'private:123', '已记录'); return true;})});
  const server = http.createServer(async (req, res) => {if (!await handler.handle(req, res, new URL(req.url, 'http://localhost'))) {res.writeHead(404); res.end();}});
  server.requestTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  async function req(route, body, extra = {}) {
    const response = await fetch(base + '/api/workbench/' + route, {method: body ? 'POST' : 'GET', headers: {cookie, ...(body ? {origin: base, 'content-type': 'application/json', 'x-workbench-csrf': csrf} : {}), ...extra}, ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, headers: response.headers, body: await response.json()};
  }
  async function login() {const r = await req('login', {username: 'fixture', password}); cookie = r.headers.get('set-cookie').split(';')[0]; csrf = r.body.csrf; return r;}
  async function action(body) {const id = crypto.randomUUID(); const r = await req('action', {requestId: id, ...body}); assert.equal(r.status, 202); return {id, r};}
  async function done(id) {for (let n = 0; n < 100; n++) {const r = await req('job?id=' + id); if (r.body.job.status !== 'running') return r.body.job; await new Promise(r => setTimeout(r, 5));} throw Error('job timed out');}
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, {recursive: true, force: true});});
  return {dir, store, calls, base, req, login, action, done, setTime: v => {clock = v;}, f};
}
test('未登录不可读资料或执行动作；静态页面无控制台令牌', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('view?tab=runtime')).status, 401);
  assert.equal((await f.req('action', {requestId: crypto.randomUUID(), action: 'note.add', text: 'x'})).status, 401);
  const page = await fetch(f.base + '/workbench');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(await page.text(), /x-console-token|consoleToken|fixture-password/);
  assert.equal(f.calls.length, 0);
});
test('密码仅存加盐scrypt；错误账号/密码被拒；Cookie不可被脚本读取', async t => {
  const f = await fixture(t), raw = fs.readFileSync(path.join(f.dir, 'workbench-auth.json'), 'utf8');
  assert.ok(!raw.includes(password)); assert.equal(JSON.parse(raw).hash.length, 128);
  assert.equal(fs.statSync(path.join(f.dir, 'workbench-auth.json')).mode & 0o777, 0o600);
  assert.equal((await f.req('login', {username: 'other', password})).status, 401);
  assert.equal((await f.req('login', {username: 'fixture', password: 'wrong'})).status, 401);
  const r = await f.login(); assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.ok((await f.req('session')).body.csrf);
  assert.equal((await f.req('logout', {})).status, 200);
  assert.equal((await f.req('session')).status, 401);
});
test('CSRF、跨站写请求、模型通道、越界会话和任意API均被拒绝', async t => {
  const f = await fixture(t); await f.login();
  const body = {requestId: crypto.randomUUID(), action: 'note.add', text: 'x'};
  assert.equal((await f.req('action', body, {origin: 'https://evil.invalid'})).status, 403);
  assert.equal((await f.req('action', body, {'x-workbench-csrf': 'wrong'})).status, 403);
  assert.equal((await f.req('view', null, {'x-agent-call': '1'})).status, 403);
  assert.equal((await f.req('view', null, {'x-agent-token': 'fake'})).status, 403);
  assert.equal((await f.req('view?tab=memory&scope=group:999')).status, 403);
  assert.equal((await f.req('proxy?path=/api/security')).status, 404);
  assert.equal(f.calls.length, 0);
});
test('登录8次限速且时间窗可恢复；凭据损坏失败关闭', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.req('login', {username: 'fixture', password: 'wrong'})).status, 401);
  assert.equal((await f.req('login', {username: 'fixture', password})).status, 429);
  f.setTime(Date.now() + 16 * 60000); assert.equal((await f.login()).status, 200);
  fs.writeFileSync(path.join(f.dir, 'workbench-auth.json'), '{}');
  assert.equal((await f.req('view')).status, 503);
});
test('写动作幂等；相同请求ID不同参数拒绝；成功只执行一次并捕获网页回复', async t => {
  const f = await fixture(t); await f.login();
  const requestId = crypto.randomUUID(), b = {requestId, action: 'note.add', text: '下周交报告'};
  await f.req('action', b); await f.req('action', b);
  const j = await f.done(requestId); assert.equal(j.status, 'succeeded');
  assert.equal(j.result.messages[0].text, '已记录'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].text, '[记一下][下周交报告]');
  assert.equal((await f.req('action', {...b, text: '别的'})).status, 409);
});
test('并行操作被拒绝；原业务错误不会报成功；指令参数不能逃逸', async t => {
  let finish;
  const f = await fixture(t, {execute: async () => {await new Promise(r => {finish = r;}); await workbenchReply(() => {}, 'private:123', '未完成：原业务失败'); return true;}});
  await f.login(); const {id} = await f.action({action: 'note.add', text: 'x'});
  await new Promise(r => setTimeout(r, 10));
  assert.equal((await f.req('action', {requestId: crypto.randomUUID(), action: 'note.add', text: 'x'})).status, 409);
  finish(); const j = await f.done(id); assert.equal(j.status, 'failed'); assert.equal(j.error, '原业务失败');
  const other = await f.action({action: 'note.add', text: 'x][清理磁盘'}); assert.equal((await f.done(other.id)).status, 'failed');
});
test('私人日记不出现在群范围；反馈保存处理意见；GET不执行业务', async t => {
  const f = await fixture(t); await f.login();
  f.store.archive('weekly', '【管理员私有周记｜不入聊天记忆】\n私人正文');
  assert.equal((await f.req('view?tab=diaries&scope=group:456')).body.data.entries.length, 0);
  assert.equal((await f.req('view?tab=diaries')).body.data.entries.length, 1);
  const {id} = await f.action({action: 'feedback.resolve', id: 'f-1', status: 'accepted', note: '下次处理'});
  assert.equal((await f.done(id)).status, 'succeeded');
  assert.equal((await f.req('view?tab=feedback')).body.data.entries[0].decision.note, '下次处理');
  assert.ok(!f.calls.some(c => c.family));
});
test('视频资料按实际分析时间72h隐藏；旧索引只含BV/分P/时间；查看不改文件', async t => {
  const f = await fixture(t); await f.login(); const at = Date.now();
  fs.mkdirSync(path.join(f.dir, 'bilibili'));
  const file = path.join(f.dir, 'bilibili/video-results.json');
  fs.writeFileSync(file, JSON.stringify({rows: [{scope: 'group:456|shared', ref: 'BV1100100004:1', at, analyzedAt: at - WORKBENCH_TTL - 1000, title: '过期标题', summary: '过期正文'}, {scope: 'private:123|123', ref: 'BV1234567891:1', at, analyzedAt: at, title: '私人视频', summary: '私人分析'}]}));
  fs.writeFileSync(path.join(f.dir, 'bilibili/video-seen.json'), JSON.stringify({refs: {'BV1100100004:1': {firstAt: at, lastAt: at}}}));
  const before = fs.readFileSync(file, 'utf8'); const data = (await f.req('view?tab=videos&scope=group:456')).body.data;
  assert.equal(data.entries.length, 0); assert.equal(data.receipts.length, 0);
  assert.equal((await f.req('view?tab=videos')).body.data.entries.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  f.setTime(at);
  f.store.event('video-share', {key: 'group:456', detail: 'old'}, at - WORKBENCH_TTL - 1);
  assert.equal(f.store.read().events.length, 0);
});
test('坏档案不能静默覆盖；会话到期/改密码撤销旧登录；Secure属性可启用', async t => {
  const f = await fixture(t), a = createWorkbenchAuth({stateDir: f.dir});
  const {token} = await a.login('fixture', password, 'test'); const request = {headers: {cookie: 'qq_workbench=' + token}};
  assert.ok(a.session(request)); await setWorkbenchAccount(f.dir, 'fixture', 'changed-password-1234'); assert.equal(a.session(request), null);
  assert.match(a.cookie('x', true), /; Secure$/);
  fs.writeFileSync(f.store.file, '{broken'); assert.throws(() => f.store.archive('diary', 'x')); assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{broken');
});

test('未来HTTPS反代使用固定来源与Secure Cookie；不信任转发头；12小时会话到期', async t => {
  const f = await fixture(t, {publicOrigin: 'https://workbench.example.com'});
  const body = {username: 'fixture', password};
  assert.equal((await f.req('login', body, {'x-forwarded-proto': 'https'})).status, 403);
  const r = await f.req('login', body, {origin: 'https://workbench.example.com'});
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /; Secure$/); assert.ok(r.headers.get('strict-transport-security'));
  const local = await fixture(t); await local.login(); local.setTime(Date.now() + 13 * 3600000);
  assert.equal((await local.req('session')).status, 401);
});
test('登录请求限制32KiB，缺失来源拒绝，非法动作不能转发到控制台', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('login', {username: 'fixture', password: 'x'.repeat(40000)})).status, 413);
  assert.equal((await f.req('login', {username: 'fixture', password}, {origin: ''})).status, 403);
  await f.login();
  const {id} = await f.action({action: '/api/restart'}); assert.equal((await f.done(id)).status, 'failed'); assert.equal(f.calls.length, 0);
});

test('本地像素字体按明确静态路径提供；字体响应类型正确，其他文件不可枚举', async t => {
  const f = await fixture(t);
  const font = await fetch(f.base + '/workbench-font.woff');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff');
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOFF');
  assert.match(font.headers.get('content-security-policy'), /font-src 'self'/);
  for (const path of ['/workbench-font.woff/private', '/workbench-font.woff%2f..%2fstate/workbench-auth.json']) {
    assert.equal((await fetch(f.base + path)).status, 404);
  }
  assert.equal((await fetch(f.base + '/workbench-font.woff', {headers: {'x-agent-call': '1'}})).status, 403);
});

test('完整指令只读GET受管理员认证保护，读取13组与补充手册不执行业务；任意执行入口拒绝', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('view?tab=commands')).status, 401);await f.login();
  const result = await f.req('view?tab=commands');assert.equal(result.status,200);assert.equal(result.body.data.sections.length,13);assert.equal(result.body.data.manuals.length,2);assert.equal(f.calls.length,0);
  assert.equal((await f.req('view?tab=commands',null,{'x-agent-call':'1'})).status,403);
  const {id} = await f.action({action:'command.execute',text:'[踢人][456][123][确认]'});
  assert.equal((await f.done(id)).status,'failed');assert.equal(f.calls.length,0);
});
