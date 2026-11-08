#!/usr/bin/env node
// 纯策略单元测试：不调用模型、不写生产 state、不需要 SnowLuma/DSH。
// 覆盖 pendingWakeReasons 过滤/优先级 与 turn watchdog 的 warn/release 边界。
import assert from 'node:assert/strict';
import {
  selectPendingWakeReasons,
  planTurnWatchdog
} from '../src/reliability.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const now = 1_800_000_000_000;
const prio = (reason) => ({ private: 100, question: 80, keyword: 60, proactiveCheck: 20 }[reason] ?? 0);

test('recent + unread -> kept and chosen', () => {
  const r = selectPendingWakeReasons({
    pendingWakeReasons: [{ reason: 'question', seq: 5, at: now - 1000 }],
    unread: [{ seq: 5 }],
    now,
    priority: prio
  });
  assert.equal(r.kept.length, 1);
  assert.equal(r.chosen.reason, 'question');
});

test('recent but already read -> dropped', () => {
  const r = selectPendingWakeReasons({
    pendingWakeReasons: [{ reason: 'question', seq: 5, at: now - 1000 }],
    unread: [],
    now,
    priority: prio
  });
  assert.equal(r.kept.length, 0);
  assert.equal(r.chosen, null);
});

test('stale (> TTL) -> dropped', () => {
  const r = selectPendingWakeReasons({
    pendingWakeReasons: [{ reason: 'question', seq: 5, at: now - 31 * 60 * 1000 }],
    unread: [{ seq: 5 }],
    now,
    priority: prio
  });
  assert.equal(r.kept.length, 0);
});

test('seq=0 recent -> kept (non-message wake)', () => {
  const r = selectPendingWakeReasons({
    pendingWakeReasons: [{ reason: 'proactiveCheck', seq: 0, at: now - 1000 }],
    unread: [],
    now,
    priority: prio
  });
  assert.equal(r.kept.length, 1);
  assert.equal(r.chosen.reason, 'proactiveCheck');
});

test('priority chooses highest reason', () => {
  const r = selectPendingWakeReasons({
    pendingWakeReasons: [
      { reason: 'proactiveCheck', seq: 0, at: now - 1000 },
      { reason: 'private', seq: 0, at: now - 2000 },
      { reason: 'keyword', seq: 0, at: now - 1500 }
    ],
    unread: [],
    now,
    priority: prio
  });
  assert.equal(r.chosen.reason, 'private');
});

test('cap keeps last 20', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ reason: 'question', seq: i + 1, at: now - 1000 - i }));
  const r = selectPendingWakeReasons({
    pendingWakeReasons: items,
    unread: items.map((i) => ({ seq: i.seq })),
    now,
    priority: prio
  });
  assert.equal(r.kept.length, 20);
});

test('malformed entries are ignored', () => {
  const r = selectPendingWakeReasons({
    pendingWakeReasons: [null, { reason: 123, seq: 1, at: now }, { reason: 'question', seq: 1, at: 'bad' }],
    unread: [{ seq: 1 }],
    now,
    priority: prio
  });
  assert.equal(r.kept.length, 0);
});

test('watchdog: below 15m -> no action', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{ sessionId: 's1', key: 'private:1', turnStartAt: now - 14 * 60 * 1000 }]
  });
  assert.deepEqual(actions, []);
});

test('watchdog: 15m -> warn once', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{ sessionId: 's1', key: 'private:1', turnStartAt: now - 15 * 60 * 1000 }]
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'warn');
  assert.equal(actions[0].key, 'private:1');
});

test('watchdog: warn cooldown suppresses repeat', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{ sessionId: 's1', key: 'private:1', turnStartAt: now - 20 * 60 * 1000, lastAlertAt: now - 5 * 60 * 1000 }]
  });
  assert.deepEqual(actions, []);
});

test('watchdog: 30m -> release even after recent warn', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{ sessionId: 's1', key: 'private:1', turnStartAt: now - 30 * 60 * 1000, lastAlertAt: now - 60 * 1000 }]
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'release');
});

test('watchdog: collector-only stuck -> release', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{ sessionId: 's2', key: 'private:2', collectorStartedAt: now - 31 * 60 * 1000 }]
  });
  assert.equal(actions[0].type, 'release');
  assert.equal(actions[0].sessionId, 's2');
});

test('watchdog: no timestamps -> no action', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{ sessionId: 's3', key: 'private:3' }]
  });
  assert.deepEqual(actions, []);
});

test('watchdog: long active turn with recent activity -> no warn', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{
      sessionId: 's4',
      key: 'private:4',
      turnStartAt: now - 20 * 60 * 1000,
      lastActivityAt: now - 2 * 60 * 1000
    }]
  });
  assert.deepEqual(actions, []);
});

test('watchdog: 15m since last activity -> warn', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{
      sessionId: 's5',
      key: 'private:5',
      turnStartAt: now - 40 * 60 * 1000,
      lastActivityAt: now - 16 * 60 * 1000
    }]
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'warn');
});

test('watchdog: 30m since last activity -> release', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{
      sessionId: 's6',
      key: 'private:6',
      turnStartAt: now - 50 * 60 * 1000,
      lastActivityAt: now - 31 * 60 * 1000
    }]
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'release');
});

test('watchdog: activity older than start falls back to start', () => {
  const actions = planTurnWatchdog({
    now,
    sessions: [{
      sessionId: 's7',
      key: 'private:7',
      turnStartAt: now - 16 * 60 * 1000,
      lastActivityAt: now - 20 * 60 * 1000
    }]
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'warn');
});

console.log(`\n${passed} passed`);
