import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {setWorkbenchAccount} from '../src/workbench-auth.js';

test('真实桥接工作台：待办/提醒/定时任务复用原状态，网页回执不发QQ；周记私有存档', async t => {
  const h = await bridgeHarness({globals: {fetch: (url, init) => {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/api\//.test(String(url))) throw Error('external calls forbidden');
    return fetch(url, init);
  }}});
  h.setMode('reserved2');
  await setWorkbenchAccount(path.join(h.temp, 'state'), 'fixture', 'bridge-fixture-password');
  const server = h.startConsoleServer(); await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close();});
  const base = `http://127.0.0.1:${server.address().port}`; let cookie, csrf;
  async function req(route, body) {
    const response = await fetch(base + '/api/workbench/' + route, {method: body ? 'POST' : 'GET', headers: {...(cookie ? {cookie} : {}), ...(body ? {'content-type': 'application/json', origin: base, 'x-workbench-csrf': csrf || ''} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, headers: response.headers, body: await response.json()};
  }
  const login = await req('login', {username: 'fixture', password: 'bridge-fixture-password'});
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]; csrf = login.body.csrf;
  async function action(body) {
    const id = crypto.randomUUID(), r = await req('action', {...body, requestId: id}); assert.equal(r.status, 202);
    for (let n = 0; n < 100; n++) {const job = (await req('job?id=' + id)).body.job; if (job.status !== 'running') {assert.equal(job.status, 'succeeded', job.error); return job;} await new Promise(r => setTimeout(r, 5));}
    throw Error('job timeout');
  }
  const overview = (await req('view?tab=overview')).body.data;
  assert.equal(overview.ownerKey, 'private:123');
  await action({action: 'note.add', text: '完成工作台'});
  assert.equal(h.ownerTools.readOwner().notes.at(-1).text, '完成工作台');
  await action({action: 'reminder.create', when: '30分钟后', text: '记得休息'});
  assert.equal(h.getReminders().get('private:123').at(-1).kind, 'ownerMemo');
  await action({action: 'task.create', key: 'group:456', when: '明天8点', text: '问候一下'});
  assert.equal(h.getReminders().get('group:456').at(-1).kind, 'ownerTask');
  await action({action: 'memory.append', key: 'group:456', text: '最近在聊工作台'});
  const groupMemory = await req('view?tab=memory&scope=group:456');
  assert.match(JSON.stringify(groupMemory.body), /工作台/);
  await action({action: 'weekly.generate'});
  const diaries = (await req('view?tab=diaries')).body.data.entries;
  assert.equal(diaries.length, 1); assert.match(diaries[0].text, /管理员私有周记/);
  assert.equal((await req('view?tab=diaries&scope=group:456')).body.data.entries.length, 0);
  assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.prompts.length, 0);
  assert.ok(!JSON.stringify(overview).includes('fixture-console-token'));
  const oldConsole = await fetch(base + '/api/status'); assert.equal(oldConsole.status, 401);
});
