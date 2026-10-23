// 好友动态查询/操作指令解析：纯函数，不做任何 I/O。
//
// owner 私聊里的自然语言：
//   查看好友动态 / 查看示例好友甲的动态 [最近3天/10月1日之后/一周内] [最多5条]
//   [点赞 2] / [评论 2] 内容 / [查看评论 2] / [删除评论 2]
// 解析结果交给 bridge.js 执行；这里只负责“听懂”。
import { beijingDayStart } from './qzone.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BJ_OFFSET_MS = 8 * HOUR_MS;

export const QZONE_FEED_QUERY_DEFAULTS = Object.freeze({
  limit: 10,
  maxLimit: 50,
  windowMs: 7 * DAY_MS,
  maxRangeMs: 366 * DAY_MS
});

function normalizeText(value) {
  return String(value ?? '')
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function beijingParts(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function buildBeijingDay(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  const start = Date.UTC(year, month - 1, day) - BJ_OFFSET_MS;
  const check = beijingParts(start);
  if (check.year !== year || check.month !== month || check.day !== day) return NaN;
  return start;
}

function unitMs(unit) {
  const u = String(unit || '');
  if (/^分(?:钟)?$/.test(u)) return MINUTE_MS;
  if (/^(?:小时|时)$/.test(u)) return HOUR_MS;
  if (/^(?:天|日)$/.test(u)) return DAY_MS;
  if (/^(?:周|星期)$/.test(u)) return 7 * DAY_MS;
  if (/^(?:个?月)$/.test(u)) return 30 * DAY_MS;
  return 0;
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 支持 3 / 三 / 十 / 十五 / 二十 / 二十五 这类数量。 */
function parseCountNumber(value) {
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + (CN_DIGITS[s[1]] ?? NaN);
  if (s.length === 2 && s[1] === '十') return (CN_DIGITS[s[0]] ?? NaN) * 10;
  if (s.length === 3 && s[1] === '十') return (CN_DIGITS[s[0]] ?? NaN) * 10 + (CN_DIGITS[s[2]] ?? NaN);
  if (s.length === 1) return CN_DIGITS[s] ?? NaN;
  return NaN;
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return QZONE_FEED_QUERY_DEFAULTS.limit;
  return Math.min(QZONE_FEED_QUERY_DEFAULTS.maxLimit, Math.max(1, Math.round(n)));
}

function findDateTokens(text, now) {
  const currentYear = beijingParts(now).year;
  const tokens = [];
  const re = /(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})[日号]?/g;
  let m;
  while ((m = re.exec(text))) {
    const year = m[1] ? Number(m[1]) : currentYear;
    const month = Number(m[2]);
    const day = Number(m[3]);
    const start = buildBeijingDay(year, month, day);
    if (!Number.isFinite(start)) continue;
    tokens.push({ start, end: start + DAY_MS - 1, index: m.index, text: m[0] });
  }
  return tokens;
}

/**
 * 解析“查看…动态”查询。
 * @returns {{ok:true, who:string, from:number, to:number, limit:number, raw:string}|{ok:false}}
 */
export function parseQzoneFeedQuery(text, now = Date.now()) {
  const raw = normalizeText(text);
  if (!raw) return { ok: false };
  const compact = raw.replace(/\s+/g, '');
  // 帮助入口：[好友动态查询] / 好友动态查询帮助 / 查看好友动态用法
  if (/^(?:好友动态查询|动态查询)(?:帮助|用法|说明)?$/.test(compact)
    || /^查看好友动态(?:帮助|用法|说明)$/.test(compact)) {
    return { ok: true, help: true, raw };
  }
  const trigger = raw.match(/^(?:查看|看看|看一下|列出|拉取|查一下|查)\s*(.+)$/);
  if (!trigger) return { ok: false };
  let rest = trigger[1].trim();
  let who = 'all';
  const allMatch = rest.match(/^(?:好友们?|大家|所有人|全部好友)(?:的)?(?:动态|说说|空间|朋友圈)/);
  if (allMatch) {
    who = 'all';
    rest = rest.slice(allMatch[0].length).trim();
  } else {
    const whoMatch = rest.match(/^(.+?)的(?:空间|说说|动态|朋友圈)/);
    if (!whoMatch) return { ok: false };
    who = whoMatch[1].trim();
    rest = rest.slice(whoMatch[0].length).trim();
  }
  if (!who) return { ok: false };

  let limit = QZONE_FEED_QUERY_DEFAULTS.limit;
  const countMatch = rest.match(/(?:最多|返回|限制|前)\s*([0-9一二两三四五六七八九十]+)\s*条|([0-9一二两三四五六七八九十]+)\s*条(?:以内|内|以下)?/);
  if (countMatch) limit = clampLimit(parseCountNumber(countMatch[1] || countMatch[2]));

  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return { ok: false };
  let from = nowMs - QZONE_FEED_QUERY_DEFAULTS.windowMs;
  let to = nowMs;

  const relative = rest.match(/(?:最近|近)?\s*([0-9一二两三四五六七八九十]+)\s*(分钟|分|小时|时|天|日|周|星期|个?月)\s*(?:内|以内|之内)?/);
  const tokens = findDateTokens(rest, nowMs);
  if (tokens.length >= 2 && /到|至|~|-/.test(rest.slice(tokens[0].index + tokens[0].text.length, tokens[1].index))) {
    from = tokens[0].start;
    to = tokens[1].end;
  } else if (tokens.length >= 1) {
    const token = tokens[0];
    const after = rest.slice(token.index + token.text.length, token.index + token.text.length + 8);
    if (/之前|以前/.test(after)) {
      // “9月30日之前”= 严格早于 9月30日 00:00；要包含当天请用“9月30日”或“到9月30日”。
      to = token.start - 1;
      from = Math.max(0, token.start - QZONE_FEED_QUERY_DEFAULTS.maxRangeMs);
    } else if (/之后|以后/.test(after)) {
      from = token.start;
      to = nowMs;
    } else {
      from = token.start;
      to = token.end;
    }
  } else if (relative) {
    const n = parseCountNumber(relative[1]);
    const unit = unitMs(relative[2]);
    if (Number.isFinite(n) && unit > 0) {
      from = nowMs - n * unit;
      to = nowMs;
    }
  } else if (/今天/.test(rest)) {
    from = beijingDayStart(nowMs);
    to = from + DAY_MS - 1;
  } else if (/昨天/.test(rest)) {
    from = beijingDayStart(nowMs) - DAY_MS;
    to = from + DAY_MS - 1;
  } else if (/前天/.test(rest)) {
    from = beijingDayStart(nowMs) - 2 * DAY_MS;
    to = from + DAY_MS - 1;
  }

  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false };
  if (from > to) [from, to] = [to, from];
  return { ok: true, who, from, to, limit: clampLimit(limit), raw };
}

/**
 * 解析对上一次查询结果的操作。
 * @returns {{ok:true, action:'like'|'comment'|'showComments'|'deleteComment', index:number, comment:string, raw:string}|{ok:false}}
 */
export function parseQzoneFeedAction(text) {
  const raw = normalizeText(text);
  if (!raw) return { ok: false };
  const indexOf = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };

  let m = raw.match(/^点赞\s*(\d+)$/) || raw.match(/^(?:给)?第?(\d+)条(?:说说)?(?:点个?赞|赞一下|点赞)$/) || raw.match(/^(?:赞|点赞)第?(\d+)条(?:说说)?$/);
  if (m) return { ok: true, action: 'like', index: indexOf(m[1]), comment: '', raw };

  m = raw.match(/^评论\s*(\d+)\s*:?\s*([\s\S]*)$/)
    || raw.match(/^评论\s*第?(\d+)条(?:说说)?\s*:?\s*([\s\S]*)$/)
    || raw.match(/^(?:给)?第?(\d+)条(?:说说)?\s*(?:评论|留言|评一句)\s*:?\s*([\s\S]*)$/);
  if (m) return { ok: true, action: 'comment', index: indexOf(m[1]), comment: String(m[2] || '').trim(), raw };

  m = raw.match(/^查看评论\s*(\d+)$/) || raw.match(/^(?:查看|看看|列出)第?(\d+)条(?:说说)?的?评论$/);
  if (m) return { ok: true, action: 'showComments', index: indexOf(m[1]), comment: '', raw };

  m = raw.match(/^(?:删除|删掉|删了)\s*评论\s*(\d+)$/)
    || raw.match(/^(?:删除|删掉|删了)第?(\d+)条(?:说说)?(?:下面|底下|上)?(?:的)?(?:我的|机器人的|机器人留下的)?评论$/)
    || raw.match(/^删除评论\s*(\d+)$/);
  if (m) return { ok: true, action: 'deleteComment', index: indexOf(m[1]), comment: '', raw };

  return { ok: false };
}

/** 给查询结果做一段人类可读的范围描述（供 bridge 回复用）。 */
export function describeQzoneFeedQuery(query) {
  const q = query || {};
  const parts = [];
  parts.push(q.who === 'all' ? '全部好友' : String(q.who || ''));
  parts.push(`最多 ${Math.min(QZONE_FEED_QUERY_DEFAULTS.maxLimit, Math.max(1, Number(q.limit) || QZONE_FEED_QUERY_DEFAULTS.limit))} 条`);
  return parts.join('｜');
}
