#!/usr/bin/env node
// 主动问候策略：纯函数测试。
import assert from 'node:assert/strict';
import {
  proactiveGreetingBlockReason,
  describeProactiveBlock,
  DEFAULT_MAX_IDLE_DAYS
} from '../src/proactive-policy.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-21T10:00:00+08:00');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n   ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

test('默认阈值是 3 天', () => {
  assert.equal(DEFAULT_MAX_IDLE_DAYS, 3);
});

test('正常对话：不阻止', () => {
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: NOW - DAY, now: NOW }), '');
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: NOW - 3 * DAY, now: NOW }), '');
});

test('超过 3 天没对话：阻止', () => {
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: NOW - 3 * DAY - 1, now: NOW }), 'stale:3');
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: NOW - 10 * DAY, now: NOW }), 'stale:3');
});

test('自定义阈值', () => {
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: NOW - 5 * DAY, now: NOW, maxIdleDays: 7 }), '');
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: NOW - 8 * DAY, now: NOW, maxIdleDays: 7 }), 'stale:7');
});

test('单会话开关优先', () => {
  assert.equal(proactiveGreetingBlockReason({ enabled: false, lastIncomingAt: NOW, now: NOW }), 'switch-off');
});

test('从未收到过消息：阻止', () => {
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: 0, now: NOW }), 'no-incoming');
});

test('中文说明', () => {
  assert.match(describeProactiveBlock('stale:3'), /超过 3 天没有对话/);
  assert.match(describeProactiveBlock('switch-off'), /手动关闭/);
  assert.match(describeProactiveBlock('no-incoming'), /还没有收到/);
  assert.equal(describeProactiveBlock(''), '正常');
});

console.log(`\nproactive-policy tests: ${passed} passed`);
