#!/usr/bin/env node
// 主动开口方向：纯数据/纯函数测试。
import assert from 'node:assert/strict';
import {
  PROACTIVE_TOPIC_SEEDS,
  pickProactiveTopic,
  buildProactiveTopicBlock
} from '../src/proactive-topics.js';

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

test('方向数量与覆盖', () => {
  assert.ok(PROACTIVE_TOPIC_SEEDS.length >= 8);
  const keys = new Set(PROACTIVE_TOPIC_SEEDS.map((s) => s.key));
  assert.equal(keys.size, PROACTIVE_TOPIC_SEEDS.length, 'key 不应重复');
  for (const seed of PROACTIVE_TOPIC_SEEDS) {
    assert.ok(seed.label, 'label 不能为空');
    assert.ok(Array.isArray(seed.examples) && seed.examples.length >= 2, seed.key);
  }
});

test('示例里不再出现猫/宠物', () => {
  for (const seed of PROACTIVE_TOPIC_SEEDS) {
    const text = [seed.label, ...seed.examples].join(' ');
    assert.doesNotMatch(text, /猫|宠物|狗|橘猫|黑猫/, `${seed.key} 仍含宠物词`);
  }
});

test('按索引轮换，且不会越界', () => {
  assert.equal(pickProactiveTopic(0).key, PROACTIVE_TOPIC_SEEDS[0].key);
  assert.equal(pickProactiveTopic(1).key, PROACTIVE_TOPIC_SEEDS[1].key);
  assert.equal(pickProactiveTopic(PROACTIVE_TOPIC_SEEDS.length).key, PROACTIVE_TOPIC_SEEDS[0].key);
  assert.equal(pickProactiveTopic(-1).key, PROACTIVE_TOPIC_SEEDS[0].key);
  assert.equal(pickProactiveTopic('bad').key, PROACTIVE_TOPIC_SEEDS[0].key);
});

test('方向块包含方向、例句、防重复与反猫规则', () => {
  const block = buildProactiveTopicBlock({
    index: 1,
    recentSelf: ['刚在楼下看到一只猫', '今天好困']
  });
  assert.match(block, /【本次主动方向】/);
  assert.match(block, new RegExp(PROACTIVE_TOPIC_SEEDS[1].label));
  assert.match(block, /不要照抄例句/);
  assert.match(block, /不要主动提猫\/宠物/);
  assert.match(block, /最近你已经主动说过/);
  assert.match(block, /刚在楼下看到一只猫/);
  assert.match(block, /不要每次都用「刚下楼\/刚路过\/看到…」开头/);
});

test('没有最近发言时不带防重复行', () => {
  const block = buildProactiveTopicBlock({ index: 0, recentSelf: [] });
  assert.doesNotMatch(block, /最近你已经主动说过/);
});

console.log(`\nproactive-topics tests: ${passed} passed`);
