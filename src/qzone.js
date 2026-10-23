// QQ空间说说策略：纯函数，不做任何 I/O。
//
// 设计边界：
// - 空间是公开面，默认最保守：仅自己可见 + owner 审批 + 严格限额。
// - 这里只负责「能不能发」的判断，真正的发送在 bridge.js 的 publishQzoneDraft。
// - 所有时间判断显式按 UTC+8（北京时间）计算，不依赖服务器本地时区。
import crypto from 'node:crypto';

const BJ_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

// 配置默认值。state/qzone.json 首次创建时用它播种；之后以 state 为准，
// 这样 /qzone on|off 之类的运行期开关不会被重启覆盖。
export const QZONE_DEFAULTS = Object.freeze({
  enabled: false,
  requireApproval: true,
  ugcRight: 64,                 // 1 公开 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分不可见
  maxPerDay: 1,
  maxPerWeek: 2,
  minIntervalMs: 18 * HOUR_MS,
  quietStartHour: 0,            // 安静时段 [0, 7)，北京时间
  quietEndHour: 7,
  dedupeTtlMs: 30 * DAY_MS,
  draftTtlMs: 24 * HOUR_MS,
  maxCaptionChars: 300,
  publishTimeoutMs: 30000,
  maxRecentHashes: 100,
  backoffBaseMs: 30 * 60 * 1000,
  backoffMaxMs: 6 * HOUR_MS,
  // 自主发说说：到点先掷一次“想不想发”，AI 还可以返回 post:false。
  autoPublish: false,
  autoProbability: 0.3,
  autoCheckMinMs: 3 * HOUR_MS,
  autoCheckMaxMs: 6 * HOUR_MS,
  autoActiveStartHour: 8,
  autoActiveEndHour: 23,
  // 自主配图：AI 可在说说 JSON 里给 imagePrompt；不是每条都需要图。
  autoImageEnabled: true,
  autoImageMaxPerDay: 1,
  autoImageMaxPerWeek: 3,
  autoImageQuality: 'fast'
});

export const QZONE_STATUS = Object.freeze({
  PENDING_OWNER: 'pending_owner',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  REJECTED: 'rejected'
});

export const QZONE_UGC_RIGHTS = Object.freeze([1, 4, 16, 64, 128]);

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

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 归一化配置/限额，非法值回退默认值。 */
export function normalizeQzoneConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ugc = Number(src.ugcRight);
  let autoCheckMinMs = clampNumber(src.autoCheckMinMs, QZONE_DEFAULTS.autoCheckMinMs, 15 * 60 * 1000, DAY_MS);
  let autoCheckMaxMs = clampNumber(src.autoCheckMaxMs, QZONE_DEFAULTS.autoCheckMaxMs, 15 * 60 * 1000, DAY_MS);
  if (autoCheckMaxMs < autoCheckMinMs) autoCheckMaxMs = autoCheckMinMs;
  return {
    enabled: src.enabled === true,
    requireApproval: src.requireApproval !== false,
    ugcRight: QZONE_UGC_RIGHTS.includes(ugc) ? ugc : QZONE_DEFAULTS.ugcRight,
    maxPerDay: clampInt(src.maxPerDay, QZONE_DEFAULTS.maxPerDay, 0, 50),
    maxPerWeek: clampInt(src.maxPerWeek, QZONE_DEFAULTS.maxPerWeek, 0, 100),
    minIntervalMs: clampNumber(src.minIntervalMs, QZONE_DEFAULTS.minIntervalMs, 0, 7 * DAY_MS),
    quietStartHour: clampInt(src.quietStartHour, QZONE_DEFAULTS.quietStartHour, 0, 23),
    quietEndHour: clampInt(src.quietEndHour, QZONE_DEFAULTS.quietEndHour, 0, 23),
    dedupeTtlMs: clampNumber(src.dedupeTtlMs, QZONE_DEFAULTS.dedupeTtlMs, 0, 365 * DAY_MS),
    draftTtlMs: clampNumber(src.draftTtlMs, QZONE_DEFAULTS.draftTtlMs, HOUR_MS, 7 * DAY_MS),
    maxCaptionChars: clampInt(src.maxCaptionChars, QZONE_DEFAULTS.maxCaptionChars, 10, 2000),
    publishTimeoutMs: clampInt(src.publishTimeoutMs, QZONE_DEFAULTS.publishTimeoutMs, 5000, 120000),
    maxRecentHashes: clampInt(src.maxRecentHashes, QZONE_DEFAULTS.maxRecentHashes, 10, 500),
    backoffBaseMs: clampNumber(src.backoffBaseMs, QZONE_DEFAULTS.backoffBaseMs, 60 * 1000, DAY_MS),
    backoffMaxMs: clampNumber(src.backoffMaxMs, QZONE_DEFAULTS.backoffMaxMs, 60 * 1000, 7 * DAY_MS),
    autoPublish: src.autoPublish === true,
    autoProbability: clampNumber(src.autoProbability, QZONE_DEFAULTS.autoProbability, 0, 1),
    autoCheckMinMs,
    autoCheckMaxMs,
    autoActiveStartHour: clampInt(src.autoActiveStartHour, QZONE_DEFAULTS.autoActiveStartHour, 0, 23),
    autoActiveEndHour: clampInt(src.autoActiveEndHour, QZONE_DEFAULTS.autoActiveEndHour, 0, 23),
    autoImageEnabled: src.autoImageEnabled !== false,
    autoImageMaxPerDay: clampInt(src.autoImageMaxPerDay, QZONE_DEFAULTS.autoImageMaxPerDay, 0, 5),
    autoImageMaxPerWeek: clampInt(src.autoImageMaxPerWeek, QZONE_DEFAULTS.autoImageMaxPerWeek, 0, 10),
    autoImageQuality: src.autoImageQuality === 'high' ? 'high' : 'fast'
  };
}

/** 北京时间的小时（0-23），显式 UTC+8。 */
export function beijingHour(now = Date.now()) {
  const ms = toMs(now);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + BJ_OFFSET_MS).getUTCHours();
}

/** 北京时间当天 00:00 对应的 epoch ms。 */
export function beijingDayStart(now = Date.now()) {
  const ms = toMs(now);
  if (!Number.isFinite(ms)) return NaN;
  return Math.floor((ms + BJ_OFFSET_MS) / DAY_MS) * DAY_MS - BJ_OFFSET_MS;
}

/**
 * 安静时段判断：返回 true 表示「现在可以发」。
 * 支持跨午夜窗口，例如 quietStartHour=22、quietEndHour=7。
 * start === end 视为不设安静时段。
 */
export function qzoneWindowOpen(now = Date.now(), opts = {}) {
  const cfg = normalizeQzoneConfig(opts);
  const hour = beijingHour(now);
  if (hour === null) return false;
  const start = cfg.quietStartHour;
  const end = cfg.quietEndHour;
  if (start === end) return true;
  if (start < end) return hour < start || hour >= end;
  return hour >= end && hour < start;
}

/**
 * 自主发说的活跃窗口（默认 8–23 点，北京时间）。与 quiet window 分开：
 * quiet 是“绝不发”的硬静默，autoActive 是“不主动检查”的作息。
 */
export function qzoneAutoWindowOpen(now = Date.now(), opts = {}) {
  const cfg = normalizeQzoneConfig(opts);
  const hour = beijingHour(now);
  if (hour === null) return false;
  const start = cfg.autoActiveStartHour;
  const end = cfg.autoActiveEndHour;
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** 下一次自动检查窗口开始的 epoch ms；当前已在窗口内则返回 now。 */
export function nextQzoneAutoWindowStart(now = Date.now(), opts = {}) {
  const cfg = normalizeQzoneConfig(opts);
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return NaN;
  if (qzoneAutoWindowOpen(nowMs, cfg)) return nowMs;
  const shifted = new Date(nowMs + BJ_OFFSET_MS);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const todayStart = dayStartShifted + cfg.autoActiveStartHour * HOUR_MS - BJ_OFFSET_MS;
  if (nowMs < todayStart) return todayStart;
  return todayStart + DAY_MS;
}

/** 两次自动检查之间的随机间隔（“偶尔”而不是整点打卡）。 */
export function nextQzoneAutoCheckMs(opts = {}, random = Math.random) {
  const cfg = normalizeQzoneConfig(opts);
  const min = cfg.autoCheckMinMs;
  const max = Math.max(min, cfg.autoCheckMaxMs);
  const r = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(min + r * (max - min));
}

/**
 * 额度检查。
 * @param {number[]} postTimes 已发布时间（epoch ms）
 * @param {number|Date} now
 * @param {object} limits 配置/限额
 * @returns {{ok:boolean,reason:string,retryAfterMs:number,today:number,week:number,lastAt:number}}
 */
export function checkQzoneQuota(postTimes, now = Date.now(), limits = {}) {
  const cfg = normalizeQzoneConfig(limits);
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) {
    return { ok: false, reason: 'invalid-now', retryAfterMs: 0, today: 0, week: 0, lastAt: 0 };
  }
  const times = (Array.isArray(postTimes) ? postTimes : [])
    .map(toMs)
    .filter((t) => Number.isFinite(t) && t <= nowMs + 60 * 1000)
    .sort((a, b) => a - b);
  const dayStart = beijingDayStart(nowMs);
  const today = times.filter((t) => t >= dayStart && t <= nowMs).length;
  const weekTimes = times.filter((t) => t >= nowMs - 7 * DAY_MS);
  const week = weekTimes.length;
  const lastAt = times.length ? times[times.length - 1] : 0;

  if (cfg.maxPerDay > 0 && today >= cfg.maxPerDay) {
    return {
      ok: false,
      reason: 'day-limit',
      retryAfterMs: Math.max(0, dayStart + DAY_MS - nowMs),
      today,
      week,
      lastAt
    };
  }
  if (cfg.maxPerWeek > 0 && week >= cfg.maxPerWeek) {
    const oldest = weekTimes[0];
    return {
      ok: false,
      reason: 'week-limit',
      retryAfterMs: Math.max(0, oldest + 7 * DAY_MS - nowMs),
      today,
      week,
      lastAt
    };
  }
  if (lastAt > 0 && cfg.minIntervalMs > 0 && nowMs - lastAt < cfg.minIntervalMs) {
    return {
      ok: false,
      reason: 'min-interval',
      retryAfterMs: Math.max(0, lastAt + cfg.minIntervalMs - nowMs),
      today,
      week,
      lastAt
    };
  }
  return { ok: true, reason: 'ok', retryAfterMs: 0, today, week, lastAt };
}

/** 用于去重的内容归一化：NFKC、小写、去掉所有空白和零宽字符。 */
export function normalizeQzoneHashText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, '');
}

/** 说说内容哈希（文字 + 可选的配图提示词）。 */
export function qzoneDedupeHash({ caption = '', imagePrompt = '' } = {}) {
  const payload = `${normalizeQzoneHashText(caption)}\n${normalizeQzoneHashText(imagePrompt)}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * 是否与最近发布过的内容重复。
 * recentHashes 支持 `{hash, at}` 或纯 hash 字符串（后者视为不过期，兼容旧状态）。
 */
export function isDuplicateQzonePost(hash, recentHashes, now = Date.now(), ttlMs = QZONE_DEFAULTS.dedupeTtlMs) {
  if (!hash) return false;
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return true;
  const ttl = Math.max(0, Number(ttlMs) || 0);
  for (const item of (Array.isArray(recentHashes) ? recentHashes : [])) {
    if (!item) continue;
    if (typeof item === 'string') {
      if (item === hash) return true;
      continue;
    }
    if (String(item.hash ?? '') !== hash) continue;
    const at = toMs(item.at);
    if (!Number.isFinite(at) || nowMs - at <= ttl) return true;
  }
  return false;
}

/** 连续失败后的退避时长：base * 2^(failures-1)，封顶 backoffMaxMs。 */
export function nextQzoneBackoffMs(failures, opts = {}) {
  const cfg = normalizeQzoneConfig(opts);
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  if (n <= 0) return 0;
  const raw = cfg.backoffBaseMs * Math.pow(2, n - 1);
  return Math.min(cfg.backoffMaxMs, Math.round(raw));
}

/** 清理展示用文案：去首尾空白、压缩空格和多余空行，保留原始标点。 */
export function normalizeQzoneCaption(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cf}/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 公开面隐私校验：返回违规代码数组（空数组 = 通过）。
 * 只拦明显不该出现在空间里的东西，不做过度内容审查。
 */
export function findQzonePrivacyViolations(text) {
  const s = String(text ?? '');
  const violations = [];
  if (/\[CQ:[^\]]+\]/i.test(s)) violations.push('cq-code');
  if (/\b(?:private|group)\s*:\s*\d+/i.test(s)) violations.push('session-key');
  if (/\b\d{5,12}\b/.test(s)) violations.push('long-number');
  if (/[A-Za-z]:[\\/][^\s]*/.test(s)) violations.push('windows-path');
  if (/(?:\/(?:opt|home|root|etc|var|srv|tmp)\/)[^\s]*/.test(s)) violations.push('unix-path');
  if (/(?:token|secret|api[_-]?key|access[_-]?key|password|passwd|authorization)\s*[:=]/i.test(s)) violations.push('secret');
  if (/memberImpressions|member_impressions/i.test(s)) violations.push('member-impressions');
  return [...new Set(violations)];
}

/** 文案校验：长度 + 隐私。返回 {ok,text,length} 或 {ok:false,error,...}。 */
export function validateQzoneCaption(caption, opts = {}) {
  const cfg = normalizeQzoneConfig(opts);
  const text = normalizeQzoneCaption(caption);
  if (!text) return { ok: false, error: 'empty' };
  const length = Array.from(text).length;
  if (length > cfg.maxCaptionChars) {
    return { ok: false, error: 'too-long', length, maxChars: cfg.maxCaptionChars };
  }
  const violations = findQzonePrivacyViolations(text);
  if (violations.length) return { ok: false, error: 'privacy', violations };
  return { ok: true, text, length };
}

/**
 * 从模型输出里解析草稿 JSON。
 * 兼容 ```json 代码块、前后寒暄、以及 caption/text/content 三种字段名。
 */
export function parseQzoneDraftJson(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'empty' };
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no-json' };
  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { ok: false, error: 'bad-json' };
  }
  const caption = obj?.caption ?? obj?.text ?? obj?.content;
  if (typeof caption !== 'string' || !caption.trim()) return { ok: false, error: 'no-caption' };
  const reason = typeof obj?.reason === 'string' ? obj.reason.trim().slice(0, 200) : '';
  return { ok: true, caption: caption.trim(), reason };
}

/**
 * 自主发说说的决策 JSON：
 *   {"post":false,"reason":"不想发"}
 *   {"post":true,"caption":"...","reason":"..."}
 * 兼容模型漏写 post 字段、只给 caption 的情况（视为想发）。
 */
export function parseQzoneAutoDraftJson(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'empty' };
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no-json' };
  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { ok: false, error: 'bad-json' };
  }
  const reason = typeof obj?.reason === 'string' ? obj.reason.trim().slice(0, 200) : '';
  const imagePrompt = typeof obj?.imagePrompt === 'string' ? obj.imagePrompt.trim().slice(0, 300) : '';
  const post = obj?.post ?? obj?.shouldPost ?? obj?.publish;
  if (post === false) return { ok: true, post: false, reason, imagePrompt: '' };
  const caption = obj?.caption ?? obj?.text ?? obj?.content;
  if (typeof caption !== 'string' || !caption.trim()) {
    // 明确说 post:true 却没给正文，是模型输出坏了；没写 post 也没正文，按“不想发”处理。
    if (post === true) return { ok: false, error: 'no-caption' };
    return { ok: true, post: false, reason: reason || 'no-caption', imagePrompt: '' };
  }
  return { ok: true, post: true, caption: caption.trim(), reason, imagePrompt };
}

/** 在 get_qzone_msg_list 的结果里按内容找一条已发布的说说。 */
export function findQzonePostByContent(msglist, caption) {
  const hash = qzoneDedupeHash({ caption });
  for (const item of (Array.isArray(msglist) ? msglist : [])) {
    if (!item || typeof item !== 'object') continue;
    if (qzoneDedupeHash({ caption: item.content ?? '' }) === hash) return item;
  }
  return null;
}

/** 毫秒转人类可读的“x小时y分钟”，用于回执。 */
export function formatQzoneWait(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 60 * 1000) return '不到 1 分钟';
  const totalMinutes = Math.ceil(n / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} 分钟`;
  if (minutes <= 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}
