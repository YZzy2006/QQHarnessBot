#!/usr/bin/env node
// Pure tests for reminder recurrence and important dates. No state/network.
import assert from 'node:assert/strict';
import {
  nextOccurrence,
  nextImportantDate,
  rescheduleReminder,
  addDays,
  formatBeijingDate,
  parseDateParts,
  parseTimeParts
} from '../src/recurrence.js';

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

const at = (s) => Date.parse(s);
const bj = (s) => Date.parse(s);

test('daily: next day same Beijing time', () => {
  const a = bj('2026-10-19T09:00:00+08:00');
  const now = bj('2026-10-19T09:00:01+08:00');
  assert.equal(nextOccurrence(a, 'daily', now), bj('2026-10-20T09:00:00+08:00'));
});

test('daily: catches up to the next future occurrence', () => {
  const a = bj('2026-10-15T09:00:00+08:00');
  const now = bj('2026-10-19T08:00:00+08:00');
  assert.equal(nextOccurrence(a, 'daily', now), bj('2026-10-19T09:00:00+08:00'));
});

test('weekly: next week same weekday/time', () => {
  const a = bj('2026-10-19T09:00:00+08:00'); // Monday
  const now = bj('2026-10-20T10:00:00+08:00');
  assert.equal(nextOccurrence(a, 'weekly', now), bj('2026-10-26T09:00:00+08:00'));
});

test('monthly: Jan 31 -> Feb 28 (non-leap)', () => {
  const a = bj('2027-01-31T09:00:00+08:00');
  const now = bj('2027-02-01T00:00:00+08:00');
  assert.equal(nextOccurrence(a, 'monthly', now), bj('2027-02-28T09:00:00+08:00'));
});

test('monthly: Jan 31 -> Feb 29 (leap)', () => {
  const a = bj('2028-01-31T09:00:00+08:00');
  const now = bj('2028-02-01T00:00:00+08:00');
  assert.equal(nextOccurrence(a, 'monthly', now), bj('2028-02-29T09:00:00+08:00'));
});

test('monthly: returns to the anchor day after a short month', () => {
  const a = bj('2027-01-31T09:00:00+08:00');
  const now = bj('2027-03-01T00:00:00+08:00');
  assert.equal(nextOccurrence(a, 'monthly', now), bj('2027-03-31T09:00:00+08:00'));
});

test('yearly: Feb 29 -> Feb 28 in non-leap year', () => {
  const a = bj('2024-02-29T09:00:00+08:00');
  const now = bj('2025-03-01T00:00:00+08:00');
  assert.equal(nextOccurrence(a, 'yearly', now), bj('2026-02-28T09:00:00+08:00'));
});

test('yearly: next year same date', () => {
  const a = bj('2026-10-19T09:00:00+08:00');
  const now = bj('2026-10-20T00:00:00+08:00');
  assert.equal(nextOccurrence(a, 'yearly', now), bj('2027-10-19T09:00:00+08:00'));
});

test('invalid repeat returns null', () => {
  assert.equal(nextOccurrence(bj('2026-10-19T09:00:00+08:00'), 'hourly', bj('2026-10-20T00:00:00+08:00')), null);
});

test('rescheduleReminder: recurring moves forward, one-shot stays null', () => {
  const now = bj('2026-10-19T09:00:01+08:00');
  const daily = rescheduleReminder({ id: 'r_1', at: bj('2026-10-19T09:00:00+08:00'), repeat: 'daily' }, now);
  assert.equal(daily.at, bj('2026-10-20T09:00:00+08:00'));
  assert.equal(daily.lastFiredAt, now);
  assert.equal(rescheduleReminder({ id: 'r_2', at: bj('2026-10-19T09:00:00+08:00') }, now), null);
});

test('rescheduleReminder: remaining 次数递减，最后一次不再续期', () => {
  const now = bj('2026-10-19T09:00:01+08:00');
  const first = rescheduleReminder({ id: 'r_1', at: bj('2026-10-19T09:00:00+08:00'), repeat: 'daily', remaining: 3 }, now);
  assert.equal(first.at, bj('2026-10-20T09:00:00+08:00'));
  assert.equal(first.remaining, 2);
  const second = rescheduleReminder(first, bj('2026-10-20T09:00:01+08:00'));
  assert.equal(second.remaining, 1);
  const third = rescheduleReminder(second, bj('2026-10-21T09:00:01+08:00'));
  assert.equal(third, null, 'remaining=1 时这次是最后一次，不再续期');
});

test('rescheduleReminder: endAt 之后不再续期', () => {
  const now = bj('2026-10-19T09:00:01+08:00');
  const endAt = bj('2026-10-21T23:59:59+08:00');
  const first = rescheduleReminder({ id: 'r_1', at: bj('2026-10-19T09:00:00+08:00'), repeat: 'daily', endAt }, now);
  assert.equal(first.at, bj('2026-10-20T09:00:00+08:00'));
  const second = rescheduleReminder(first, bj('2026-10-20T09:00:01+08:00'));
  assert.equal(second.at, bj('2026-10-21T09:00:00+08:00'));
  const third = rescheduleReminder(second, bj('2026-10-21T09:00:01+08:00'));
  assert.equal(third, null, '下一期 10-22 已超过 endAt');
});

test('important date: past year means this or next year', () => {
  const now = bj('2026-10-19T12:00:00+08:00');
  assert.equal(nextImportantDate('1998-12-01', '09:00', 'yearly', now), bj('2026-12-01T09:00:00+08:00'));
  assert.equal(nextImportantDate('1998-10-01', '09:00', 'yearly', now), bj('2027-10-01T09:00:00+08:00'));
});

test('important date: today before time is today, after time is next year', () => {
  const now = bj('2026-10-19T08:00:00+08:00');
  assert.equal(nextImportantDate('2026-10-19', '09:00', 'yearly', now), bj('2026-10-19T09:00:00+08:00'));
  const later = bj('2026-10-19T10:00:00+08:00');
  assert.equal(nextImportantDate('2026-10-19', '09:00', 'yearly', later), bj('2027-10-19T09:00:00+08:00'));
});

test('important date: one-shot must be future', () => {
  const now = bj('2026-10-19T12:00:00+08:00');
  assert.equal(nextImportantDate('2026-10-19', '09:00', 'none', now), null);
  assert.equal(nextImportantDate('2026-11-01', '09:00', 'none', now), bj('2026-11-01T09:00:00+08:00'));
});

test('advance days and date formatting', () => {
  const at = bj('2026-11-01T09:00:00+08:00');
  assert.equal(addDays(at, -3), bj('2026-10-29T09:00:00+08:00'));
  assert.equal(formatBeijingDate(at), '2026-11-01');
});

test('date/time parsers reject bad input', () => {
  assert.equal(parseDateParts('2026-02-30'), null);
  assert.equal(parseDateParts('2026-1-1'), null);
  assert.equal(parseTimeParts('24:00'), null);
  assert.equal(parseTimeParts('9:00'), null);
});

void at;
console.log(`\n${passed} passed`);
