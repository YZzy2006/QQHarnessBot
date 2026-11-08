// Recurrence helpers for QQ reminders and important dates.
//
// All calculations are done in Beijing time (UTC+8). China has no DST, so
// daily/weekly steps are exact multiples of 24h. Monthly/yearly steps clamp
// the day-of-month (Jan 31 + 1 month -> Feb 28/29) while keeping the original
// anchor day, so a Jan 31 reminder returns to Jan 31 after February.

const DAY_MS = 24 * 60 * 60 * 1000;
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

export const REPEAT_TYPES = Object.freeze(['daily', 'weekly', 'monthly', 'yearly']);
export const REPEAT_TEXT = Object.freeze({
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年'
});

function toBeijingParts(ms) {
  const d = new Date(Number(ms) + BJ_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds()
  };
}

function fromBeijingParts({ y, mo, d, h = 0, mi = 0, s = 0 }) {
  return Date.UTC(y, mo, d, h, mi, s) - BJ_OFFSET_MS;
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
}

function clampDay(y, mo, d) {
  return Math.max(1, Math.min(Number(d) || 1, daysInMonth(y, mo)));
}

function addMonths(ms, n) {
  const p = toBeijingParts(ms);
  const total = p.y * 12 + p.mo + Number(n);
  const y = Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  return fromBeijingParts({
    y,
    mo,
    d: clampDay(y, mo, p.d),
    h: p.h,
    mi: p.mi,
    s: p.s
  });
}

function addYears(ms, n) {
  const p = toBeijingParts(ms);
  const y = p.y + Number(n);
  return fromBeijingParts({
    y,
    mo: p.mo,
    d: clampDay(y, p.mo, p.d),
    h: p.h,
    mi: p.mi,
    s: p.s
  });
}

/**
 * Next occurrence strictly after `now`. Returns null for invalid input.
 * Daily/weekly use arithmetic; monthly/yearly use Beijing calendar parts.
 */
export function nextOccurrence(atMs, repeat, now = Date.now()) {
  const at = Number(atMs);
  const nowMs = Number(now);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  if (!REPEAT_TYPES.includes(String(repeat || ''))) return null;
  if (at > nowMs) return at;

  if (repeat === 'daily') {
    const n = Math.floor((nowMs - at) / DAY_MS) + 1;
    return at + n * DAY_MS;
  }
  if (repeat === 'weekly') {
    const step = 7 * DAY_MS;
    const n = Math.floor((nowMs - at) / step) + 1;
    return at + n * step;
  }
  if (repeat === 'monthly') {
    const anchor = toBeijingParts(at);
    const current = toBeijingParts(nowMs);
    let n = Math.max(1, (current.y - anchor.y) * 12 + (current.mo - anchor.mo));
    let candidate = addMonths(at, n);
    let guard = 0;
    while (candidate <= nowMs && guard++ < 10000) {
      n += 1;
      candidate = addMonths(at, n);
    }
    while (n > 1 && addMonths(at, n - 1) > nowMs) {
      n -= 1;
      candidate = addMonths(at, n);
    }
    return candidate > nowMs ? candidate : null;
  }
  if (repeat === 'yearly') {
    const anchor = toBeijingParts(at);
    const current = toBeijingParts(nowMs);
    let n = Math.max(1, current.y - anchor.y);
    let candidate = addYears(at, n);
    let guard = 0;
    while (candidate <= nowMs && guard++ < 10000) {
      n += 1;
      candidate = addYears(at, n);
    }
    while (n > 1 && addYears(at, n - 1) > nowMs) {
      n -= 1;
      candidate = addYears(at, n);
    }
    return candidate > nowMs ? candidate : null;
  }
  return null;
}

/**
 * Return a copy of a due recurring reminder moved to its next future
 * occurrence, or null for one-shot/invalid reminders. Kept pure so the
 * bridge's delivery loop can be tested without timers.
 */
export function rescheduleReminder(reminder, now = Date.now()) {
  if (!reminder || typeof reminder !== 'object') return null;
  const repeat = String(reminder.repeat || '');
  if (!REPEAT_TYPES.includes(repeat)) return null;
  const at = Number(reminder.at);
  const nowMs = Number(now);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;

  // remaining = 总共还要触发几次（含当前这次）。1 表示这次是最后一次。
  const remainingRaw = Number(reminder.remaining);
  const hasRemaining = reminder.remaining !== null && reminder.remaining !== undefined
    && Number.isFinite(remainingRaw);
  if (hasRemaining && remainingRaw <= 1) return null;

  const anchor = Number(reminder.recurrenceAnchorAt) || at;
  const nextAt = nextOccurrence(anchor, repeat, nowMs + 1);
  if (!Number.isFinite(nextAt) || nextAt <= nowMs) return null;

  // endAt：最后一次允许触发的时间点（含）。超过就不再排下一期。
  const endAtRaw = Number(reminder.endAt);
  if (reminder.endAt !== null && reminder.endAt !== undefined
    && Number.isFinite(endAtRaw) && endAtRaw > 0 && nextAt > endAtRaw) {
    return null;
  }

  const next = { ...reminder, at: nextAt, lastFiredAt: nowMs };
  if (hasRemaining) next.remaining = remainingRaw - 1;
  return next;
}

export function parseDateParts(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, mo, d };
}

export function parseTimeParts(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value || '09:00').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

/**
 * Resolve an important date to its next occurrence.
 * - yearly: uses month/day; a past year means "this year or next year".
 * - none: exact date; must be in the future.
 * Returns null for invalid/past one-shot dates.
 */
export function nextImportantDate(dateStr, timeStr = '09:00', repeat = 'yearly', now = Date.now()) {
  const dp = parseDateParts(dateStr);
  const tp = parseTimeParts(timeStr);
  const nowMs = Number(now);
  if (!dp || !tp || !Number.isFinite(nowMs)) return null;

  if (repeat === 'yearly') {
    const current = toBeijingParts(nowMs);
    let y = Math.max(dp.y, current.y);
    let candidate = fromBeijingParts({
      y,
      mo: dp.mo,
      d: clampDay(y, dp.mo, dp.d),
      h: tp.h,
      mi: tp.mi
    });
    if (candidate <= nowMs) {
      y += 1;
      candidate = fromBeijingParts({
        y,
        mo: dp.mo,
        d: clampDay(y, dp.mo, dp.d),
        h: tp.h,
        mi: tp.mi
      });
    }
    return candidate;
  }

  const candidate = fromBeijingParts({
    y: dp.y,
    mo: dp.mo,
    d: dp.d,
    h: tp.h,
    mi: tp.mi
  });
  return candidate > nowMs ? candidate : null;
}

export function addDays(ms, days) {
  const base = Number(ms);
  const n = Number(days);
  if (!Number.isFinite(base) || !Number.isFinite(n)) return null;
  return base + n * DAY_MS;
}

export function formatBeijingDate(ms) {
  const p = toBeijingParts(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
}
