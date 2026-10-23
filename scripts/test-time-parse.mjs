#!/usr/bin/env node
// 中文自然语言时间解析：纯函数测试，固定北京时间 2026-10-21 10:00（周三）。
import assert from 'node:assert/strict';
import { parseChineseTime, parseScheduledTime, parseEndDate, cnNumber } from '../src/time-parse.js';

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

function expectOk(text, expected) {
  const parsed = parseChineseTime(text, NOW);
  assert.equal(parsed.ok, true, `${text}: ${parsed.error || ''}`);
  assert.equal(parsed.text, expected, text);
}

test('中文数字', () => {
  assert.equal(cnNumber('十'), 10);
  assert.equal(cnNumber('十二'), 12);
  assert.equal(cnNumber('二十'), 20);
  assert.equal(cnNumber('二十三'), 23);
  assert.equal(cnNumber('两'), 2);
  assert.equal(cnNumber('8'), 8);
  assert.ok(Number.isNaN(cnNumber('abc')));
});

test('相对时间', () => {
  expectOk('10分钟后', '2026-10-21 10:10');
  expectOk('半小时后', '2026-10-21 10:30');
  expectOk('2小时后', '2026-10-21 12:00');
  expectOk('3天后', '2026-10-24 10:00');
  expectOk('1周后', '2026-10-28 10:00');
});

test('明天/后天/时段', () => {
  expectOk('明天早上', '2026-10-22 08:00');
  expectOk('明天早上8点', '2026-10-22 08:00');
  expectOk('明天8点半', '2026-10-22 08:30');
  expectOk('明晚8点', '2026-10-22 20:00');
  expectOk('明早7点', '2026-10-22 07:00');
  expectOk('后天', '2026-10-23 09:00');
  expectOk('后天晚上', '2026-10-23 20:00');
});

test('今天/今晚 + 时刻', () => {
  expectOk('今天下午3点', '2026-10-21 15:00');
  expectOk('中午12点', '2026-10-21 12:00');
  expectOk('今晚8点', '2026-10-21 20:00');
  expectOk('今晚8点半', '2026-10-21 20:30');
  expectOk('今晚12点', '2026-10-22 00:00');
});

test('没写日期且已过：按明天', () => {
  expectOk('8点', '2026-10-22 08:00');
  expectOk('早上7点', '2026-10-22 07:00');
});

test('星期几', () => {
  // 2026-10-21 周三；最近周五是 10-23。
  expectOk('周五晚上7点半', '2026-10-23 19:30');
  expectOk('星期六早上9点', '2026-10-24 09:00');
  expectOk('周日晚上8点', '2026-10-25 20:00');
});

test('绝对日期', () => {
  expectOk('2026-10-22 09:30', '2026-10-22 09:30');
  expectOk('2026/10/22 9点', '2026-10-22 09:00');
  expectOk('10月23日晚上8点', '2026-10-23 20:00');
  expectOk('10-24 早上7点', '2026-10-24 07:00');
});

test('过去/非法时间返回明确错误', () => {
  for (const text of ['今天早上8点', '2020-01-01 09:00', '随便', '', '25点', '2月30日']) {
    const parsed = parseChineseTime(text, NOW);
    assert.equal(parsed.ok, false, text);
    assert.equal(typeof parsed.error, 'string');
    assert.ok(parsed.error.length > 0);
  }
});

test('重复任务：每天/每周/每月/每年', () => {
  let p = parseScheduledTime('每天8点', NOW);
  assert.equal(p.ok, true);
  assert.equal(p.repeat, 'daily');
  assert.equal(p.text, '每天 08:00');
  assert.equal(p.at, Date.parse('2026-10-22T08:00:00+08:00'));

  p = parseScheduledTime('每天早上8点', NOW);
  assert.equal(p.at, Date.parse('2026-10-22T08:00:00+08:00'));

  p = parseScheduledTime('每周五晚上7点半', NOW);
  assert.equal(p.repeat, 'weekly');
  assert.equal(p.text, '每周五 19:30');
  assert.equal(p.at, Date.parse('2026-10-23T19:30:00+08:00'));

  p = parseScheduledTime('每周三晚上8点', NOW);
  assert.equal(p.at, Date.parse('2026-10-21T20:00:00+08:00'));

  p = parseScheduledTime('每月1号早上9点', NOW);
  assert.equal(p.repeat, 'monthly');
  assert.equal(p.text, '每月1日 09:00');
  assert.equal(p.at, Date.parse('2026-11-01T09:00:00+08:00'));

  p = parseScheduledTime('每年10月1日', NOW);
  assert.equal(p.repeat, 'yearly');
  assert.equal(p.text, '每年10月1日 09:00');
  assert.equal(p.at, Date.parse('2027-10-01T09:00:00+08:00'));

  p = parseScheduledTime('每年12月1日', NOW);
  assert.equal(p.at, Date.parse('2026-12-01T09:00:00+08:00'));

  p = parseScheduledTime('每天', NOW);
  assert.equal(p.at, Date.parse('2026-10-22T09:00:00+08:00'));
  assert.equal(parseScheduledTime('每天吃早饭', NOW).ok, false);
});

test('一次性任务仍走原解析', () => {
  const p = parseScheduledTime('明天早上8点', NOW);
  assert.equal(p.ok, true);
  assert.equal(p.repeat, null);
  assert.equal(p.repeatText, '一次性');
});

test('结束日期：带年/不带年/非法', () => {
  let e = parseEndDate('到2026-10-28', NOW);
  assert.equal(e.ok, true);
  assert.equal(e.text, '2026-10-28');
  assert.equal(e.at, Date.parse('2026-10-29T00:00:00+08:00') - 1);

  e = parseEndDate('截止10月28日', NOW);
  assert.equal(e.ok, true);
  assert.equal(e.text, '2026-10-28');

  e = parseEndDate('到2月30日', NOW);
  assert.equal(e.ok, false);

  assert.equal(parseEndDate('随便', NOW), null);
});

console.log(`\ntime-parse tests: ${passed} passed`);
