// 中文自然语言时间解析：纯函数，按北京时间（UTC+8）计算。
//
// 支持：
//   10分钟后 / 2小时后 / 3天后 / 1周后 / 半小时后
//   今天/明天/后天/大后天 [早上|上午|中午|下午|傍晚|晚上|凌晨] [8点|8:30]
//   明天早上 / 今晚8点 / 周五晚上7点半
//   2026-10-21 08:00 / 10-21 08:00 / 10月21日 08:00
//
// 设计取舍：宁可给一个「没听懂，请换种说法」的明确错误，也不猜一个可能错的时间。
import { beijingParts } from './model-prices.js';

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字 0~99 → 整数；解析失败返回 NaN。 */
export function cnNumber(text) {
  const s = String(text ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);

  if (s === '十') return 10;
  if (s.length === 1) return CN_DIGITS[s] ?? NaN;

  const m = s.match(/^(.?)(十)(.?)$/);
  if (m) {
    const tens = m[1] ? (CN_DIGITS[m[1]] ?? NaN) : 1;
    const ones = m[3] ? (CN_DIGITS[m[3]] ?? NaN) : 0;
    return tens * 10 + ones;
  }

  // 「二三」这类不规范的写法按逐位拼接（仅用于 2 位）。
  let value = 0;
  for (const ch of s) {
    const d = CN_DIGITS[ch];
    if (d === undefined) return NaN;
    value = value * 10 + d;
  }
  return value;
}

function todayParts(nowMs) {
  const p = beijingParts(nowMs);
  const [y, m, d] = p.date.split('-').map(Number);
  return { y, m, d, weekday: p.weekday, hour: p.hour, minute: Number(p.clock.slice(3)) };
}

function toMs(y, m, d, hour, minute) {
  return Date.UTC(y, m - 1, d, hour - 8, minute, 0, 0);
}

function addDays(y, m, d, days) {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function fmt(ms) {
  const p = beijingParts(ms);
  return `${p.date} ${p.clock}`;
}

const PERIODS = ['凌晨', '早上', '早晨', '上午', '中午', '下午', '傍晚', '晚上', '夜里', '夜晚', '深夜'];
const PERIOD_DEFAULT = {
  凌晨: 5, 早上: 8, 早晨: 8, 上午: 9, 中午: 12, 下午: 15,
  傍晚: 18, 晚上: 20, 夜里: 22, 夜晚: 22, 深夜: 22
};

function findPeriod(text) {
  for (const p of PERIODS) if (text.includes(p)) return p;
  return '';
}

function applyPeriod(hour, period) {
  if (period === '凌晨') return hour === 12 ? 0 : hour;
  if (period === '早上' || period === '早晨' || period === '上午') return hour === 12 ? 0 : hour;
  if (period === '中午') return hour < 11 ? hour + 12 : hour;
  if (period === '下午' || period === '傍晚') return hour < 12 ? hour + 12 : hour;
  if (period === '晚上' || period === '夜里' || period === '夜晚' || period === '深夜') {
    if (hour === 12) return 0;
    return hour < 12 ? hour + 12 : hour;
  }
  return hour;
}

/** 从文本里抽 HH:mm / H点M分 / H点半；没有则 null。 */
function extractClock(text) {
  const s = String(text ?? '');
  let m = s.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour <= 23 && minute <= 59) return { hour, minute, matched: m[0] };
    return { invalid: true };
  }
  m = s.match(/(\d{1,2})\s*点\s*(半|\d{1,2})?\s*分?/);
  if (m) {
    const hour = Number(m[1]);
    const minute = m[2] === '半' ? 30 : (m[2] ? Number(m[2]) : 0);
    if (hour <= 23 && minute <= 59) return { hour, minute, matched: m[0] };
    return { invalid: true };
  }
  return null;
}

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function clampDay(y, m, d) {
  return Math.max(1, Math.min(Number(d) || 1, daysInMonth(y, m)));
}

/** 星期几的中文写法。 */
const WEEKDAY_CN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };

function removeOnce(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) return text;
  return `${text.slice(0, idx)} ${text.slice(idx + needle.length)}`;
}

function futureOrError(at, nowMs, raw) {
  if (!Number.isFinite(at)) return { ok: false, error: '没听懂这个时间，请换一种写法，例如 [明天早上8点]' };
  if (at <= nowMs + 1000) {
    return { ok: false, error: `「${raw}」对应的时间已经过去了，请说一个未来的时间。` };
  }
  return { ok: true, at, text: fmt(at) };
}

function normalizeTimeText(value) {
  return String(value ?? '').trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/\s+/g, '')
    .replace(/[。！!？?]+$/g, '');
}

/**
 * 解析自然语言时间。
 * @param {string} input
 * @param {number} nowMs
 * @returns {{ok:true,at:number,text:string}|{ok:false,error:string}}
 */
export function parseChineseTime(input, nowMs = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '时间不能为空。' };

  // 统一全角数字/标点，去空白。
  let t = normalizeTimeText(raw);
  if (!t) return { ok: false, error: '时间不能为空。' };

  const now = Number(nowMs);
  const base = todayParts(now);

  // ── 1. 相对时间 ────────────────────────────────────────────────────────
  if (/半\s*(?:个)?\s*小时\s*(?:后|以后|之后)/.test(t)) {
    return futureOrError(now + 30 * 60000, now, raw);
  }
  let rel = t.match(/([零〇一二两三四五六七八九十\d]+)\s*(个)?\s*(分钟|分|小时|钟头|天|日|周|星期|月)\s*(?:后|以后|之后)/);
  if (rel) {
    const n = cnNumber(rel[1]);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `没听懂「${rel[1]}」是多久。` };
    }
    const unit = rel[3];
    let ms = 0;
    if (unit === '分钟' || unit === '分') ms = n * 60000;
    else if (unit === '小时' || unit === '钟头') ms = n * 3600000;
    else if (unit === '天' || unit === '日') ms = n * 86400000;
    else if (unit === '周' || unit === '星期') ms = n * 7 * 86400000;
    else if (unit === '月') ms = n * 30 * 86400000; // 近似：定时任务按 30 天记
    return futureOrError(now + ms, now, raw);
  }

  // ── 2. 绝对日期（带年/不带年）─────────────────────────────────────────
  // 先摘出日期，避免把 2026-10-21 里的数字当时钟。
  const dateFull = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?/);
  const dateShort = !dateFull && t.match(/(\d{1,2})[-/.月](\d{1,2})[日号]?/);
  if (dateFull || dateShort) {
    const y = dateFull ? Number(dateFull[1]) : base.y;
    const m = Number(dateFull ? dateFull[2] : dateShort[1]);
    const d = Number(dateFull ? dateFull[3] : dateShort[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31 || !validDate(y, m, d)) {
      return { ok: false, error: `日期「${dateFull?.[0] ?? dateShort?.[0]}」不合法。` };
    }
    const dateText = dateFull ? dateFull[0] : dateShort[0];
    const rest = removeOnce(t, dateText);
    const period = findPeriod(rest);
    const clock = extractClock(rest);
    if (clock?.invalid) return { ok: false, error: '时间里的「点/分」超出范围。' };
    const hour = clock ? applyPeriod(clock.hour, period) : (period ? PERIOD_DEFAULT[period] : 9);
    const minute = clock ? clock.minute : 0;
    let at = toMs(y, m, d, hour, minute);
    if (!dateFull && at <= now) {
      // 没写年份且已过：按下一年的同一天理解（生日/纪念日常见）。
      if (!validDate(y + 1, m, d)) {
        return { ok: false, error: `日期「${dateShort[0]}」在明年不存在（例如 2 月 29 日）。` };
      }
      at = toMs(y + 1, m, d, hour, minute);
    }
    return futureOrError(at, now, raw);
  }

  // ── 3. 星期几 ─────────────────────────────────────────────────────────
  const week = t.match(/(?:周|星期|礼拜)([一二三四五六日天1-7])/);
  if (week) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    const target = /^[1-7]$/.test(week[1]) ? Number(week[1]) : map[week[1]];
    if (!target) return { ok: false, error: `没听懂星期「${week[1]}」。` };
    const rest = removeOnce(t, week[0]);
    const period = findPeriod(rest);
    const clock = extractClock(rest);
    if (clock?.invalid) return { ok: false, error: '时间里的「点/分」超出范围。' };
    const hour = clock ? applyPeriod(clock.hour, period) : (period ? PERIOD_DEFAULT[period] : 9);
    const minute = clock ? clock.minute : 0;
    let delta = (target - base.weekday + 7) % 7;
    let { y, m, d } = addDays(base.y, base.m, base.d, delta);
    let at = toMs(y, m, d, hour, minute);
    if (at <= now) {
      ({ y, m, d } = addDays(base.y, base.m, base.d, delta + 7));
      at = toMs(y, m, d, hour, minute);
    }
    return futureOrError(at, now, raw);
  }

  // ── 4. 今天/明天/后天/大后天 + 时段 + 可选时刻 ───────────────────────
  // 先把「今晚/明晚/明早」这类合成词拆成「今天+晚上」。
  const compounds = {
    大后天晚上: ['大后天', '晚上'], 大后天早上: ['大后天', '早上'],
    后天晚上: ['后天', '晚上'], 后天早上: ['后天', '早上'],
    明晚: ['明天', '晚上'], 明早: ['明天', '早上'], 明晨: ['明天', '早上'],
    今晚: ['今天', '晚上'], 今早: ['今天', '早上'], 今晨: ['今天', '早上']
  };
  for (const [word, [day, period]] of Object.entries(compounds)) {
    if (t.includes(word)) { t = t.replace(word, `${day}${period}`); break; }
  }

  let dayOffset = null;
  let dayWord = '';
  for (const [word, offset] of [['大后天', 3], ['后天', 2], ['明天', 1], ['明日', 1], ['今天', 0], ['今日', 0]]) {
    if (t.includes(word)) {
      dayOffset = offset;
      dayWord = word;
      t = removeOnce(t, word);
      break;
    }
  }

  const period = findPeriod(t);
  const clock = extractClock(t);
  if (clock?.invalid) return { ok: false, error: '时间里的「点/分」超出范围。' };

  if (dayOffset === null && !period && !clock) {
    return { ok: false, error: '没听懂这个时间，请换一种写法，例如 [明天早上8点]、[2小时后]、[周五晚上7点]。' };
  }

  let hour;
  let minute = 0;
  if (clock) {
    hour = applyPeriod(clock.hour, period);
    minute = clock.minute;
  } else if (period) {
    hour = PERIOD_DEFAULT[period];
  } else {
    hour = 9;
  }

  const offset = dayOffset === null ? 0 : dayOffset;
  let { y, m, d } = addDays(base.y, base.m, base.d, offset);
  let at = toMs(y, m, d, hour, minute);
  if (dayOffset === null && at <= now) {
    // 没写哪一天、时间已过：按明天理解（例如晚上说「8点」）。
    ({ y, m, d } = addDays(base.y, base.m, base.d, 1));
    at = toMs(y, m, d, hour, minute);
  }
  if (dayOffset === 0 && at <= now) {
    // 「今晚12点」= 今晚结束/明天 0 点，按明天算。
    if (clock && clock.hour === 12 && /晚上|夜里|夜晚|深夜/.test(period)) {
      at += 86400000;
    } else {
      return { ok: false, error: `「${dayWord}${raw.replace(dayWord, '')}」的时间已经过去了，请说一个未来的时间。` };
    }
  }
  return futureOrError(at, now, raw);
}

// ── 重复任务时间（每天/每周/每月/每年）──────────────────────────────────

/**
 * 识别重复前缀。返回 {repeat, rest, weekday?, month?, day?} 或 null。
 * 例：每天8点 / 每周五晚上7点 / 每月1号早上9点 / 每年10月1日
 */
export function parseRepeatPrefix(input) {
  const t = normalizeTimeText(input);
  if (!t) return null;

  let m = t.match(/^每(?:天|日)(.*)$/);
  if (m) return { repeat: 'daily', rest: m[1] };

  m = t.match(/^每(?:周|星期|礼拜)([一二三四五六日天1-7])(.*)$/);
  if (m) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    const weekday = /^[1-7]$/.test(m[1]) ? Number(m[1]) : map[m[1]];
    return { repeat: 'weekly', weekday, rest: m[2] };
  }

  m = t.match(/^每(?:个)?月([零〇一二三四五六七八九十\d]{1,3})[号日](.*)$/);
  if (m) {
    const day = cnNumber(m[1]);
    if (!Number.isFinite(day)) return null;
    return { repeat: 'monthly', day, rest: m[2] };
  }

  m = t.match(/^每年([零〇一二三四五六七八九十\d]{1,3})月([零〇一二三四五六七八九十\d]{1,3})[日号](.*)$/);
  if (m) {
    const month = cnNumber(m[1]);
    const day = cnNumber(m[2]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { repeat: 'yearly', month, day, rest: m[3] };
  }

  return null;
}

function parseRepeating(rep, nowMs, raw) {
  const now = Number(nowMs);
  const base = todayParts(now);
  const rest = String(rep.rest ?? '');
  const period = findPeriod(rest);
  const clock = extractClock(rest);
  if (clock?.invalid) return { ok: false, error: '时间里的「点/分」超出范围。' };

  // 去掉时段/时刻后还有别的字，说明没听懂（例如「每天吃早饭」）。
  let leftover = rest;
  if (period) leftover = leftover.replace(period, '');
  if (clock?.matched) leftover = leftover.replace(clock.matched, '');
  if (leftover.replace(/[的地在]/g, '').trim()) {
    return { ok: false, error: `没听懂「${raw}」里的时间，请写成「每天8点」「每周五晚上7点」这种。` };
  }

  const hour = clock ? applyPeriod(clock.hour, period) : (period ? PERIOD_DEFAULT[period] : 9);
  const minute = clock ? clock.minute : 0;
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  if (rep.repeat === 'daily') {
    let at = toMs(base.y, base.m, base.d, hour, minute);
    if (at <= now) at += 86400000;
    return { ok: true, at, text: `每天 ${hhmm}`, repeat: 'daily', repeatText: '每天' };
  }

  if (rep.repeat === 'weekly') {
    const target = Number(rep.weekday);
    if (!target || target < 1 || target > 7) return { ok: false, error: '星期几没听懂，请写成「每周五」。' };
    const delta = (target - base.weekday + 7) % 7;
    let { y, m, d } = addDays(base.y, base.m, base.d, delta);
    let at = toMs(y, m, d, hour, minute);
    if (at <= now) {
      ({ y, m, d } = addDays(base.y, base.m, base.d, delta + 7));
      at = toMs(y, m, d, hour, minute);
    }
    return { ok: true, at, text: `每周${WEEKDAY_CN[target]} ${hhmm}`, repeat: 'weekly', repeatText: '每周' };
  }

  if (rep.repeat === 'monthly') {
    const day = Number(rep.day);
    if (!Number.isFinite(day) || day < 1 || day > 31) return { ok: false, error: '每月几号没听懂（1~31）。' };
    let y = base.y;
    let m = base.m;
    let d = clampDay(y, m, day);
    let at = toMs(y, m, d, hour, minute);
    if (at <= now) {
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      d = clampDay(y, m, day);
      at = toMs(y, m, d, hour, minute);
    }
    return { ok: true, at, text: `每月${day}日 ${hhmm}`, repeat: 'monthly', repeatText: '每月' };
  }

  if (rep.repeat === 'yearly') {
    const month = Number(rep.month);
    const day = Number(rep.day);
    if (!Number.isFinite(month) || month < 1 || month > 12) return { ok: false, error: '月份没听懂（1~12）。' };
    if (!Number.isFinite(day) || day < 1 || day > 31) return { ok: false, error: '日期没听懂（1~31）。' };
    let y = base.y;
    let d = clampDay(y, month, day);
    let at = toMs(y, month, d, hour, minute);
    if (at <= now) {
      y += 1;
      d = clampDay(y, month, day);
      at = toMs(y, month, d, hour, minute);
    }
    return { ok: true, at, text: `每年${month}月${day}日 ${hhmm}`, repeat: 'yearly', repeatText: '每年' };
  }

  return { ok: false, error: '没听懂重复规则。' };
}

/**
 * 定时任务用：先识别「每天/每周/每月/每年」，没有则按一次性时间解析。
 * @returns {{ok:true,at:number,text:string,repeat:string|null,repeatText:string}|{ok:false,error:string}}
 */
export function parseScheduledTime(input, nowMs = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '时间不能为空。' };
  const rep = parseRepeatPrefix(raw);
  if (!rep) {
    const one = parseChineseTime(raw, nowMs);
    return one.ok
      ? { ...one, repeat: null, repeatText: '一次性' }
      : one;
  }
  return parseRepeating(rep, nowMs, raw);
}

/**
 * 解析「到2026-10-28 / 截止10月28日」这类结束日期。
 * 返回 null 表示不是结束日期表达式；{ok:false} 表示像但不合法。
 * at 是当天北京时间 23:59:59.999。
 */
export function parseEndDate(input, nowMs = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const t = normalizeTimeText(raw);
  const base = todayParts(Number(nowMs) || Date.now());

  let m = t.match(/^(?:到|截止|截至|直到)(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/);
  let y;
  let mo;
  let d;
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    m = t.match(/^(?:到|截止|截至|直到)(\d{1,2})[-/.月](\d{1,2})[日号]?$/);
    if (!m) return null;
    y = base.y;
    mo = Number(m[1]);
    d = Number(m[2]);
  }

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || !validDate(y, mo, d)) {
    return { ok: false, error: `结束日期「${raw}」不合法。` };
  }

  // 没写年份且已过：按明年同一天（与一次性日期一致）。
  let endOfDay = toMs(y, mo, d + 1, 0, 0) - 1;
  if (!/^\d{4}/.test(t.replace(/^(?:到|截止|截至|直到)/, '')) && endOfDay < Number(nowMs)) {
    y += 1;
    if (!validDate(y, mo, d)) return { ok: false, error: `结束日期「${raw}」在明年不存在。` };
    endOfDay = toMs(y, mo, d + 1, 0, 0) - 1;
  }
  return {
    ok: true,
    at: endOfDay,
    text: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  };
}
