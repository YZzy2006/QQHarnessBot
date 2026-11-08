import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBilibiliState} from '../src/bilibili-state.js';
import {createBilibiliExperience} from '../src/bilibili-experience.js';
import {createBilibiliRole} from '../src/bilibili-role.js';
import {WORKBENCH_TTL} from '../src/workbench-store.js';

test('已分析候选的记录不延长标题期限；只记录真实选择与实际发送的感想', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-video-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const now = Date.now(), analyzedAt = now - 48 * 3600000, events = [], state = createBilibiliState({stateDir: dir});
  const candidate = {bvid: 'BV1100100004', title: '旧候选标题', url: 'https://www.bilibili.com/video/BV1100100004', origin: '推荐'};
  const e = createBilibiliExperience({state, now: () => now, isAllowed: () => true, canNotify: () => true,
    recordEvent: (...args) => events.push(args), results: {lookup: () => ({summary: '已有资料', analyzedAt, title: candidate.title}), save: () => {}},
    client: {recommend: async () => [candidate], search: async () => [], read: async () => {throw Error('must reuse');}},
    role: {snapshot: () => ({version: 'v1'}), keywords: async () => ['旅行'], choose: async () => candidate.bvid, composeShare: async () => '实际发送的感想'},
    send: async () => ({sent: true, commentSent: true, messageId: 1})});
  await e.browse({sourceKey: 'private:123', userId: '123'}, {authorize: () => true, automatic: false});
  assert.equal(events[0][0], 'video-candidates'); assert.equal(events[0][2], analyzedAt);
  assert.equal(events[0][2] + WORKBENCH_TTL, now + 24 * 3600000);
  assert.equal(events[1][1].bvid, candidate.bvid); assert.equal(events[2][1].detail, '实际发送的感想'); assert.equal(events[2][2], analyzedAt);
});
test('选片偏好进入现有搜索/选择请求，不增加模型轮次、不替换人物卡', async () => {
  const calls = [], role = createBilibiliRole({getRole: () => ({name: '原人物卡', text: '原卡正文', presetText: '原预设', version: 'v1'}),
    getPreferences: () => ({include: '旅行、音乐', avoid: '连续烤肉'}),
    request: async q => {calls.push(q); return q.kind === 'keywords' ? '{"keywords":["旅行"]}' : '{"bvid":null}';}});
  assert.deepEqual(await role.keywords({}), ['旅行']); assert.equal(await role.choose({}, []), null);
  assert.equal(calls.length, 2);
  for (const q of calls) {assert.match(q.system, /原卡正文/); assert.match(q.system, /旅行、音乐/); assert.match(q.system, /连续烤肉/); assert.match(q.system, /B站评论或任何B站写操作/);}
});
