import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anniversarySpec, nextAnniversary, companionTime, lunarParts } from '../src/companion-dates.js';
const now = Date.parse('2026-10-22T08:00:00+08:00');
test('Gregorian dates reject overflow, preserve leap day and distinguish one-shot/yearly', () => {
  assert.throws(() => anniversarySpec('2026-02-29'), /无效/);
  assert.equal(new Date(nextAnniversary(anniversarySpec('每年2-29'), now)).toISOString(), '2028-02-29T01:00:00.000Z');
  assert.throws(() => nextAnniversary(anniversarySpec('2026-10-21'), now), /未来有效日期/);
  assert.equal(nextAnniversary(anniversarySpec('每年10-22'), now), Date.parse('2026-10-22T09:00:00+08:00'));
});
test('Chinese lunar calendar uses Intl conversion and persists exact lunar month/day', () => {
  assert.deepEqual(lunarParts(Date.parse('2026-02-17T09:00:00+08:00')), { year: 2026, month: 1, day: 1, leap: false });
  const at = nextAnniversary(anniversarySpec('每年农历1月1日'), Date.parse('2026-01-01T00:00:00+08:00'));
  assert.equal(at, Date.parse('2026-02-17T09:00:00+08:00'));
});
test('capsules accept calendar months with month-end clamping and reject repeat rules', () => {
  const at = companionTime('一个月后', Date.parse('2026-01-31T08:00:00+08:00'));
  assert.equal(at, Date.parse('2026-02-28T08:00:00+08:00'));
  assert.equal(companionTime('两个月后', now), Date.parse('2026-12-22T08:00:00+08:00'));
  assert.throws(() => companionTime('每天9点', now), /未来时间/);
});
