import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCompanion, parseCompanionCommand } from '../src/companion.js';
function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-companion-'));
  let clock = Date.parse('2026-10-22T08:00:00+08:00'); const sent = [];
  const d = { stateDir: dir, ownerQQ: () => '123', now: () => clock,
    atomicWrite: (f, s) => fs.writeFileSync(f, JSON.stringify(s)), isAllowed: () => true,
    send: async (key, text) => { sent.push({ key, text }); return true; }, compose: async () => '一起慢慢来呀。',
    ...overrides };
  return { d, c: createCompanion(d), sent, advance: (ms) => clock += ms, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('storage persists, isolates owner, refuses corruption and does not overwrite after backup failure', () => {
  const f = fixture();
  try {
    f.c.change((p) => p.city = '杭州'); assert.equal(createCompanion(f.d).profile().city, '杭州');
    assert.equal(createCompanion({ ...f.d, ownerQQ: () => '456' }).profile().city, '');
    const c = createCompanion({ ...f.d, backup: () => { throw Error('backup failed'); } });
    assert.throws(() => c.change((p) => p.city = '北京'), /backup failed/); assert.equal(f.c.profile().city, '杭州');
    fs.writeFileSync(f.c.file, '{}'); assert.throws(() => f.c.change((p) => p.city = '北京'), /损坏/); assert.equal(fs.readFileSync(f.c.file, 'utf8'), '{}');
  } finally { f.close(); }
});
test('natural commands stay specific, ordinary conversation not intercepted', () => {
  assert.equal(parseCompanionCommand('[陪伴帮助]').command, '陪伴帮助');
  assert.equal(parseCompanionCommand('[专注状态]').command, '专注状态');
  assert.equal(parseCompanionCommand('陪我写代码半小时').command, '陪我专注');
  assert.equal(parseCompanionCommand('记住这一刻，第一次跑通').args[0], '第一次跑通');
  assert.equal(parseCompanionCommand('我觉得天气挺好的'), null);
  assert.equal(parseCompanionCommand('你说的附近那个地方'), null);
});
const ctx = { sourceKey: 'private:123', userId: '123' };
test('quoted memories retain provenance, corrections preserve original, group owner details stay private', async () => {
  const f = fixture({ getMessage: async () => ({ group_id: 888, sender: { user_id: 456, nickname: '群友' }, time: 1792627200, message: [{ type: 'text', data: { text: '第一次跑通' } }] }) });
  try {
    await f.c.handle({ sourceKey: 'group:888', userId: 123, quotedId: '99' }, '[记住这一刻][终于好了]');
    const m = f.c.profile().memories[0]; assert.equal(m.messageId, '99'); assert.equal(m.author, '群友');
    assert.ok(f.sent.filter((m) => m.key === 'group:888').every((m) => !m.text.includes('第一次跑通')));
    await f.c.handle(ctx, `[更正回忆][${m.id}][是第二次]`);
    assert.equal(f.c.profile().memories[0].text, '第一次跑通');
    assert.equal(f.c.profile().memories[0].correction, '是第二次');
    await f.c.handle(ctx, `[删除回忆][${m.id}][不确认]`); assert.equal(f.c.profile().memories.length, 1);
    assert.equal(await f.c.handle({ ...ctx, userId: 456 }, '[回忆]'), false);
    assert.equal(f.c.memoryContext('group:888'), '');
  } finally { f.close(); }
});
test('focus suppresses only owner private automatic openings, expires once, extends after completion and survives restart', async () => {
  const f = fixture();
  try {
    await f.c.handle(ctx, '陪我写代码半小时'); assert.ok(f.c.focusUntil(ctx.sourceKey)); assert.equal(f.c.focusUntil('group:888'), 0);
    f.advance(31 * 60000); f.sent.length = 0;
    const restart = createCompanion(f.d); await Promise.all([restart.tick(), restart.tick()]); await restart.tick();
    assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /进展怎么样/);
    await restart.handle(ctx, '[延长专注][15分钟]'); assert.ok(restart.focusUntil(ctx.sourceKey) > f.d.now());
    await restart.handle(ctx, '[结束专注]'); assert.equal(restart.profile().focus, null);
  } finally { f.close(); }
});
test('capsule saves response at creation, retries failed delivery and cannot be consumed by another owner', async () => {
  let fail = false;
  const f = fixture({ send: async (key, text) => { if (fail) return false; f.sent.push({ key, text }); return true; } });
  try {
    await f.c.handle(ctx, '[时光胶囊][1分钟后][给未来的自己][附言]');
    const id = f.c.profile().capsules[0].id; assert.equal(f.c.profile().capsules[0].response, '一起慢慢来呀。');
    f.advance(61000); fail = true; await f.c.tick(); assert.equal(f.c.profile().capsules[0].completedAt, undefined);
    fail = false; f.advance(121000); f.sent.length = 0; await createCompanion(f.d).tick();
    assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /给未来的自己/); assert.ok(f.c.profile().capsules[0].completedAt);
    await f.c.handle({ ...ctx, userId: 456 }, `[取消胶囊][${id}][确认]`); assert.equal(f.c.profile().capsules.length, 1);
  } finally { f.close(); }
});
test('anniversary lead reminder advances to due date and yearly recurrence, optional voice only on due date', async () => {
  let voices = 0;
  const f = fixture({ speak: async () => voices++ });
  try {
    await f.c.handle(ctx, '[纪念日][上线][每年10-23][提前1天][语音]');
    f.advance(3600001); await f.c.tick(); assert.equal(f.c.profile().anniversaries[0].phase, 'due'); assert.equal(voices, 0);
    f.advance(86400000); await f.c.tick(); assert.equal(voices, 1);
    assert.match(new Date(f.c.profile().anniversaries[0].dueAt).toISOString(), /2027-10-23/);
  } finally { f.close(); }
});
test('nearby positions and search selection are scoped to sender and conversation and expire', async () => {
  const f = fixture({ life: { searchPlaces: async () => ({ places: [{ id: 'poi', name: '店', lon: 120, lat: 30 }] }) } });
  try {
    const a = { sourceKey: 'group:888', userId: 456 }, b = { ...a, userId: 789 };
    f.c.acceptLocation(a, { lon: 120, lat: 30 }); assert.equal(f.c.locationFor(b), null);
    await assert.rejects(f.c.queryPlaces(b, { query: '咖啡', nearby: true }), /还不知道/);
    await f.c.queryPlaces(a, { query: '咖啡', nearby: true }); assert.equal(f.c.selectedPlace(a, 'poi').name, '店');
    assert.throws(() => f.c.selectedPlace(b, 'poi'), /最近10分钟/);
    f.advance(31 * 60000); assert.equal(f.c.locationFor(a), null); assert.throws(() => f.c.selectedPlace(a, 'poi'), /最近10分钟/);
  } finally { f.close(); }
});
test('weather concern is once daily, respects focus/global gates and retryable send failure', async () => {
  let permitted = false, fail = false, requests = 0;
  const f = fixture({ canNotify: () => permitted,
    life: { weather: async () => { requests++; return { source: '高德天气', provider: 'gaode', city: '杭州', queriedAt: f.d.now(), current: { text: '晴', temp: 20 },
      days: [{ date: '2026-10-22', min: 16, max: 25, day: '晴', night: '晴' }, { date: '2026-10-23', min: 10, max: 18, day: '小雨', night: '雨' }], hours: [], limitations: [], attribution: 'https://www.amap.com' }; } },
    send: async (key, text) => { if (fail) return false; f.sent.push({ key, text }); return true; } });
  try {
    f.c.change((p) => p.city = '杭州'); await f.c.tick(); assert.equal(requests, 0);
    permitted = true; fail = true; await f.c.tick(); assert.equal(f.c.profile().weatherNotifiedDate, '');
    f.advance(16 * 60000); fail = false; await f.c.tick(); await f.c.tick(); assert.equal(f.sent.length, 1); assert.equal(f.c.profile().weatherNotifiedDate, '2026-10-22');
    assert.match(f.sent[0].text, /明天最高温18℃/);
  } finally { f.close(); }
});
test('cancel during delayed anniversary generation prevents sending and nested corruption cannot overwrite', async () => {
  let release, entered;
  const started = new Promise((r) => entered = r);
  const f = fixture({ compose: async () => { entered(); return new Promise((r) => release = r); } });
  try {
    await f.c.handle(ctx, '[纪念日][项目上线][2026-10-22]'); f.advance(3600001); f.sent.length = 0;
    const pending = f.c.tick(); await started;
    const id = f.c.profile().anniversaries[0].id;
    await f.c.handle(ctx, `[删除纪念日][${id}][确认]`); f.sent.length = 0; release('祝福'); await pending; assert.equal(f.sent.length, 0);
    const raw = JSON.parse(fs.readFileSync(f.c.file, 'utf8')); raw.owners['123'].memories.push({}); fs.writeFileSync(f.c.file, JSON.stringify(raw));
    assert.throws(() => f.c.change((p) => p.city = '北京'), /格式错误/);
    assert.match(f.c.memoryContext('private:123'), /无法读取/);
  } finally { f.close(); }
});
