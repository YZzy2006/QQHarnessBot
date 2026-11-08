// QQ空间好友动态互动策略：纯函数，不做任何 I/O。
//
// 设计边界：
// - 好友都是接受这个机器人的，所以不做白名单/审批；唯一硬过滤是空间自带广告。
// - 这里只负责「看到什么、能不能互动、内容是否合格」，真正发请求在 bridge.js。
// - 时间判断显式按 UTC+8（北京时间），不依赖服务器本地时区。
import { beijingHour, findQzonePrivacyViolations } from './qzone.js';

const BJ_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;

// 运行时开关（enabled/likeEnabled/commentEnabled）以 state/qzone-social.json 为准；
// 其余限额/窗口从 config.json 的 socialV2.qzoneSocial 读。
export const QZONE_SOCIAL_DEFAULTS = Object.freeze({
  enabled: false,
  likeEnabled: true,
  commentEnabled: true,
  // 评论/追评先私聊 owner 确认；owner 回 [评论确认]/[评论修改]/[评论取消]。
  requireCommentApproval: true,
  commentApprovalTtlMs: 24 * HOUR_MS,
  // 固定检查时段：10:00 / 22:00（北京时间）。checkMin/Max 只在没有合法时段时兜底。
  checkTimes: [10 * 60, 22 * 60],
  checkMinMs: 12 * HOUR_MS,
  checkMaxMs: 12 * HOUR_MS,
  activeStartHour: 8,
  activeEndHour: 23,
  // 每次只扫最新的一小段动态：不把整页好友动态都看一遍。
  feedFetchCount: 10,
  feedScanLimit: 5,
  feedMaxAgeHours: 168,        // 只扫一周内的动态
  likeWindowHours: 72,         // 3 天内可赞
  commentWindowHours: 48,      // 2 天内可评
  likeProbability: 0.7,
  commentProbability: 0.5,
  maxLikesPerDay: 8,
  maxCommentsPerDay: 3,
  maxLikesPerFriendPerDay: 1,
  maxCommentsPerFriendPerDay: 1,
  maxActionsPerCheck: 3,
  maxCommentsPerCheck: 1,
  actionGapMs: 1500,
  likeMinIntervalMs: 90 * MINUTE_MS,
  commentMinIntervalMs: 3 * HOUR_MS,
  // 评论要像随手接话，允许“哈哈”“离谱”“行”这种 1 字回复。
  commentMinChars: 1,
  commentMaxChars: 30,
  // 追评：有人回复机器人在这条说说下的评论时，再决定要不要接一句。
  followUpEnabled: true,
  followUpMaxAgeHours: 720,    // 一个月内的帖子有人回复都可以追评（只受首页可见性限制）
  maxFollowUpsPerDay: 2,
  maxFollowUpsPerPost: 2,
  maxFollowUpsPerCheck: 1,
  followUpMinIntervalMs: 3 * HOUR_MS,
  seenTtlMs: 30 * DAY_MS,
  maxSeen: 500
});

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

function truncateCodePoints(text, max) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('') + '…';
}

function normalizeCommentText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 ["10:00","22:00"] / [600,1320] 归一化成排好序的分钟数数组。 */
export function normalizeQzoneSocialCheckTimes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      const v = Math.round(item);
      if (v >= 0 && v < 24 * 60) out.push(v);
      continue;
    }
    if (typeof item === 'string') {
      const m = item.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const v = Number(m[1]) * 60 + Number(m[2]);
      if (v >= 0 && v < 24 * 60) out.push(v);
    }
  }
  const unique = [...new Set(out)].sort((a, b) => a - b);
  return unique.length ? unique : [...QZONE_SOCIAL_DEFAULTS.checkTimes];
}

/** 配置归一化：所有数值夹到安全范围，缺失用默认值。 */
export function normalizeQzoneSocialConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const checkMinMs = clampInt(r.checkMinMs, QZONE_SOCIAL_DEFAULTS.checkMinMs, 5 * MINUTE_MS, DAY_MS);
  const checkMaxMs = Math.max(checkMinMs, clampInt(r.checkMaxMs, QZONE_SOCIAL_DEFAULTS.checkMaxMs, 5 * MINUTE_MS, DAY_MS));
  const commentMinChars = clampInt(r.commentMinChars, QZONE_SOCIAL_DEFAULTS.commentMinChars, 1, 100);
  const commentMaxChars = Math.max(commentMinChars, clampInt(r.commentMaxChars, QZONE_SOCIAL_DEFAULTS.commentMaxChars, 1, 100));
  return {
    enabled: r.enabled === true,
    likeEnabled: r.likeEnabled !== false,
    commentEnabled: r.commentEnabled !== false,
    requireCommentApproval: r.requireCommentApproval !== false,
    commentApprovalTtlMs: clampInt(r.commentApprovalTtlMs, QZONE_SOCIAL_DEFAULTS.commentApprovalTtlMs, HOUR_MS, 7 * DAY_MS),
    checkTimes: normalizeQzoneSocialCheckTimes(r.checkTimes),
    checkMinMs,
    checkMaxMs,
    activeStartHour: clampInt(r.activeStartHour, QZONE_SOCIAL_DEFAULTS.activeStartHour, 0, 23),
    activeEndHour: clampInt(r.activeEndHour, QZONE_SOCIAL_DEFAULTS.activeEndHour, 0, 23),
    feedFetchCount: clampInt(r.feedFetchCount, QZONE_SOCIAL_DEFAULTS.feedFetchCount, 1, 50),
    feedScanLimit: clampInt(r.feedScanLimit, QZONE_SOCIAL_DEFAULTS.feedScanLimit, 1, 50),
    feedMaxAgeHours: clampInt(r.feedMaxAgeHours, QZONE_SOCIAL_DEFAULTS.feedMaxAgeHours, 1, 168),
    likeWindowHours: clampInt(r.likeWindowHours, QZONE_SOCIAL_DEFAULTS.likeWindowHours, 1, 168),
    commentWindowHours: clampInt(r.commentWindowHours, QZONE_SOCIAL_DEFAULTS.commentWindowHours, 1, 168),
    likeProbability: clampNumber(r.likeProbability, QZONE_SOCIAL_DEFAULTS.likeProbability, 0, 1),
    commentProbability: clampNumber(r.commentProbability, QZONE_SOCIAL_DEFAULTS.commentProbability, 0, 1),
    maxLikesPerDay: clampInt(r.maxLikesPerDay, QZONE_SOCIAL_DEFAULTS.maxLikesPerDay, 0, 100),
    maxCommentsPerDay: clampInt(r.maxCommentsPerDay, QZONE_SOCIAL_DEFAULTS.maxCommentsPerDay, 0, 100),
    maxLikesPerFriendPerDay: clampInt(r.maxLikesPerFriendPerDay, QZONE_SOCIAL_DEFAULTS.maxLikesPerFriendPerDay, 0, 20),
    maxCommentsPerFriendPerDay: clampInt(r.maxCommentsPerFriendPerDay, QZONE_SOCIAL_DEFAULTS.maxCommentsPerFriendPerDay, 0, 20),
    maxActionsPerCheck: clampInt(r.maxActionsPerCheck, QZONE_SOCIAL_DEFAULTS.maxActionsPerCheck, 1, 20),
    maxCommentsPerCheck: clampInt(r.maxCommentsPerCheck, QZONE_SOCIAL_DEFAULTS.maxCommentsPerCheck, 0, 5),
    actionGapMs: clampInt(r.actionGapMs, QZONE_SOCIAL_DEFAULTS.actionGapMs, 0, 10000),
    likeMinIntervalMs: clampInt(r.likeMinIntervalMs, QZONE_SOCIAL_DEFAULTS.likeMinIntervalMs, 0, DAY_MS),
    commentMinIntervalMs: clampInt(r.commentMinIntervalMs, QZONE_SOCIAL_DEFAULTS.commentMinIntervalMs, 0, DAY_MS),
    commentMinChars,
    commentMaxChars,
    followUpEnabled: r.followUpEnabled !== false,
    followUpMaxAgeHours: clampInt(r.followUpMaxAgeHours, QZONE_SOCIAL_DEFAULTS.followUpMaxAgeHours, 1, 720),
    maxFollowUpsPerDay: clampInt(r.maxFollowUpsPerDay, QZONE_SOCIAL_DEFAULTS.maxFollowUpsPerDay, 0, 20),
    maxFollowUpsPerPost: clampInt(r.maxFollowUpsPerPost, QZONE_SOCIAL_DEFAULTS.maxFollowUpsPerPost, 0, 10),
    maxFollowUpsPerCheck: clampInt(r.maxFollowUpsPerCheck, QZONE_SOCIAL_DEFAULTS.maxFollowUpsPerCheck, 0, 5),
    followUpMinIntervalMs: clampInt(r.followUpMinIntervalMs, QZONE_SOCIAL_DEFAULTS.followUpMinIntervalMs, 0, DAY_MS),
    seenTtlMs: clampInt(r.seenTtlMs, QZONE_SOCIAL_DEFAULTS.seenTtlMs, HOUR_MS, 90 * DAY_MS),
    maxSeen: clampInt(r.maxSeen, QZONE_SOCIAL_DEFAULTS.maxSeen, 50, 2000)
  };
}

/**
 * 广告/非说说过滤。任一命中即跳过：
 * - uin<=0、appid!==311、昵称为空
 * - key 以 advertisement 开头
 * - html 含广告标记（实测 data-complete_adinfo / f-single-biz）
 */
export function isQzoneAdFeed(feed) {
  if (!feed || typeof feed !== 'object') return true;
  const uin = Number(feed.uin) || 0;
  const appid = Number(feed.appid) || 0;
  const nickname = String(feed.nickname ?? '').trim();
  const key = String(feed.key ?? '');
  const html = String(feed.html ?? '');
  if (uin <= 0) return true;
  if (appid !== 311) return true;
  if (!nickname) return true;
  if (/^advertisement/i.test(key)) return true;
  if (html.includes('data-complete_adinfo')) return true;
  // 注意：不要用 f-single-biz 单独判广告 —— 普通单条动态也会带这个 class。
  return false;
}

/** 是否是机器人自己的说说。自 UIN 未知时返回 false（由调用方 fail-closed）。 */
export function isSelfFeed(feed, selfUin) {
  const self = Number(selfUin) || 0;
  const uin = Number(feed?.uin) || 0;
  return self > 0 && uin === self;
}

/** 从 feed.html 里剥出正文：去脚本/样式/标签/实体/昵称/日期/浏览量/点赞列表。 */
export function extractFeedText(feed, maxChars = 160) {
  let text = String(feed?.html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|span|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const nick = String(feed?.nickname ?? '').trim();
  if (nick && text.startsWith(nick)) text = text.slice(nick.length).trim();
  text = text.replace(/^(?:今天|昨天|前天|\d{1,2}月\d{1,2}日)\s*\d{1,2}:\d{2}\s*/, '').trim();

  // 正文后面通常跟「浏览N次 / +N / 点赞人列表」；在这些标记前截断。
  const cut = text.search(/浏览\s*\d+\s*次|收起|展开|全文/);
  if (cut > 0) text = text.slice(0, cut).trim();
  text = text.replace(/\s*\+\d+\s*.*$/, '').trim();
  // 纯图片/无正文的说说只剩“浏览135次”，不要把它当正文。
  if (/^(?:浏览|阅读|查看|围观)\s*\d+\s*次$/i.test(text)) return '';
  return truncateCodePoints(text, maxChars);
}

/**
 * 限制每次扫描的范围和条数：
 * - 只保留 feedMaxAgeHours 内的动态；
 * - 去掉广告/自己/非 appid=311；
 * - 按时间倒序取前 feedScanLimit 条。
 * 返回 `usableFeeds` 是年龄过滤后但未截断的列表（追评要用全部已评论帖子）。
 */
export function limitQzoneSocialFeeds(feeds, {
  selfUin = 0,
  now = Date.now(),
  maxAgeHours = QZONE_SOCIAL_DEFAULTS.feedMaxAgeHours,
  followUpMaxAgeHours = QZONE_SOCIAL_DEFAULTS.followUpMaxAgeHours,
  limit = QZONE_SOCIAL_DEFAULTS.feedScanLimit
} = {}) {
  const nowMs = toMs(now);
  const list = Array.isArray(feeds) ? feeds : [];
  const maxAgeMs = Math.max(1, Number(maxAgeHours) || QZONE_SOCIAL_DEFAULTS.feedMaxAgeHours) * HOUR_MS;
  const followUpMaxAgeMs = Math.max(maxAgeMs, (Number(followUpMaxAgeHours) || QZONE_SOCIAL_DEFAULTS.followUpMaxAgeHours) * HOUR_MS);
  const max = Math.max(1, Math.round(Number(limit) || QZONE_SOCIAL_DEFAULTS.feedScanLimit));
  const dropped = { invalid: 0, ad: 0, self: 0, notMood: 0, old: 0, overLimit: 0 };
  const droppedFeeds = [];
  const drop = (feed, reason) => {
    droppedFeeds.push({ tid: String(feed?.key ?? ''), reason, nickname: String(feed?.nickname ?? '') });
  };
  const usable = [];
  const followUpFeeds = [];
  for (const feed of list) {
    if (!feed || typeof feed !== 'object') { dropped.invalid += 1; drop(feed, 'invalid'); continue; }
    if (Number(feed.appid) !== 311) { dropped.notMood += 1; drop(feed, 'not-mood'); continue; }
    if (isQzoneAdFeed(feed)) { dropped.ad += 1; drop(feed, 'ad'); continue; }
    if (isSelfFeed(feed, selfUin)) { dropped.self += 1; drop(feed, 'self'); continue; }
    const time = Number(feed.time) || 0;
    if (!time) { dropped.invalid += 1; drop(feed, 'bad-time'); continue; }
    const ageMs = nowMs - time * 1000;
    if (!Number.isFinite(ageMs) || ageMs < -60 * 1000) { dropped.invalid += 1; drop(feed, 'bad-time'); continue; }
    // 追评池比“新互动扫描池”宽：一周~一个月前的帖子只要还在首页，也要能查回复。
    if (ageMs <= followUpMaxAgeMs) followUpFeeds.push(feed);
    if (ageMs > maxAgeMs) { dropped.old += 1; drop(feed, 'old'); continue; }
    usable.push(feed);
  }
  usable.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
  followUpFeeds.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
  const scanned = usable.slice(0, max);
  const over = usable.slice(max);
  dropped.overLimit = over.length;
  for (const feed of over) drop(feed, 'over-limit');
  return {
    feeds: scanned,
    usableFeeds: usable,
    followUpFeeds,
    usable: usable.length,
    scanned: scanned.length,
    dropped,
    droppedFeeds
  };
}

/**
 * 从好友动态里挑出可互动的说说。
 * 窗口判断在调用方按 ageMs 分别做（点赞 24h / 评论 12h）。
 */
export function selectQzoneSocialCandidates(feeds, {
  selfUin = 0,
  now = Date.now(),
  likeWindowMs = QZONE_SOCIAL_DEFAULTS.likeWindowHours * HOUR_MS,
  commentWindowMs = QZONE_SOCIAL_DEFAULTS.commentWindowHours * HOUR_MS,
  seen = {}
} = {}) {
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return { eligible: [], skipped: [] };
  const maxWindow = Math.max(0, Number(likeWindowMs) || 0, Number(commentWindowMs) || 0);
  const list = Array.isArray(feeds) ? feeds : [];
  const seenMap = seen && typeof seen === 'object' ? seen : {};
  const skipped = [];
  const byTid = new Map();

  for (const feed of list) {
    const tid = String(feed?.key ?? '').trim();
    const skip = (reason) => skipped.push({ tid, reason, nickname: String(feed?.nickname ?? '') });
    if (!feed || typeof feed !== 'object') { skip('invalid'); continue; }
    if (Number(feed.appid) !== 311) { skip('not-mood'); continue; }
    if (isQzoneAdFeed(feed)) { skip('ad'); continue; }
    if (isSelfFeed(feed, selfUin)) { skip('self'); continue; }
    if (!tid) { skip('no-key'); continue; }
    // 实测说说 tid 是 24 位 hex；广告/聚合卡/推荐位的 key 不是这个形状。
    if (!/^[0-9a-f]{16,40}$/i.test(tid)) { skip('bad-tid'); continue; }
    const time = Number(feed.time) || 0;
    if (time <= 0) { skip('bad-time'); continue; }
    const ageMs = nowMs - time * 1000;
    if (ageMs < -60 * 1000) { skip('bad-time'); continue; }
    if (maxWindow > 0 && ageMs > maxWindow) { skip('stale'); continue; }
    const prior = seenMap[tid];
    // 评论失败/已追评到上限的帖子不再重试；只赞过还没评论的帖子仍可进入候选，
    // 但下面的动作判断会阻止重复点赞。
    if (prior && prior.error) { skip('seen'); continue; }
    if (prior && prior.likedAt && prior.commentedAt) { skip('seen'); continue; }
    if (byTid.has(tid)) { skip('duplicate'); continue; }
    byTid.set(tid, {
      uin: Number(feed.uin) || 0,
      nickname: String(feed.nickname ?? '').trim(),
      tid,
      time,
      text: extractFeedText(feed, 160),
      ageMs: Math.max(0, ageMs),
      likedAt: Math.max(0, Number(prior?.likedAt) || 0),
      commentedAt: Math.max(0, Number(prior?.commentedAt) || 0)
    });
  }

  const eligible = [...byTid.values()].sort((a, b) => b.time - a.time);
  return { eligible, skipped };
}

function stripCommentHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQzoneCommentChunk(chunk, openTag) {
  const attr = (name) => {
    const m = openTag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
    return m ? m[1] : '';
  };
  const type = attr('data-type');
  const id = attr('data-tid');
  const uin = Number(attr('data-uin')) || 0;
  const nick = attr('data-nick') || '';
  const idx = chunk.indexOf('comments-content');
  if (idx < 0) return null;
  let body = chunk.slice(idx + 'comments-content'.length).replace(/^"[^>]*>/, '');
  const opIdx = body.search(/<div[^>]*class="[^"]*comments-op/i);
  if (opIdx >= 0) body = body.slice(0, opIdx);
  // 去掉作者锚点
  body = body.replace(/^[\s\S]*?<a\b[^>]*>[\s\S]*?<\/a>/i, ' ');
  // 回复评论：抓「回复 <a ...>目标</a>」里的目标 uin
  let replyToUin = 0;
  let replyToNick = '';
  const target = body.match(/回复\s*<a\b[^>]*href="[^"]*user\.qzone\.qq\.com\/(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (target) {
    replyToUin = Number(target[1]) || 0;
    replyToNick = stripCommentHtml(target[2]);
    body = body.replace(target[0], ' ');
  }
  const text = stripCommentHtml(body).replace(/^[:：]\s*/, '').trim();
  const timeMatch = chunk.match(/<span[^>]*class="[^"]*state[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const timeText = timeMatch ? stripCommentHtml(timeMatch[1]) : '';
  return { type, id, uin, nick, text, timeText, replyToUin, replyToNick };
}

/**
 * 从说说 HTML 里解析评论树。Qzone 的 feed HTML 已经带 comments-list；
 * 根评论是 data-type="commentroot"，回复是 replyroot，回复里通常有「回复 <a>目标</a>」。
 * 返回 {roots, repliesToSelf}；repliesToSelf 只包含“别人回复机器人”的条目。
 */
export function parseQzoneFeedComments(html, { selfUin = 0, selfNickname = '' } = {}) {
  const source = String(html ?? '');
  const re = /<li\b[^>]*class="[^"]*comments-item[^"]*"[^>]*>/gi;
  const opens = [];
  let m;
  while ((m = re.exec(source))) opens.push({ index: m.index, tag: m[0] });
  const roots = [];
  let current = null;
  for (let i = 0; i < opens.length; i += 1) {
    const start = opens[i].index;
    const end = i + 1 < opens.length ? opens[i + 1].index : source.length;
    const item = parseQzoneCommentChunk(source.slice(start, end), opens[i].tag);
    if (!item || !item.text) continue;
    const isSelf = (Number(selfUin) > 0 && item.uin === Number(selfUin))
      || (!Number(selfUin) && selfNickname && item.nick === selfNickname);
    if (item.type === 'commentroot' || !current) {
      current = { ...item, isSelf, replies: [] };
      roots.push(current);
      continue;
    }
    const reply = { ...item, isSelf };
    if (!reply.replyToUin && !reply.replyToNick && current) {
      reply.replyToUin = current.uin;
      reply.replyToNick = current.nick;
    }
    current.replies.push(reply);
  }
  const repliesToSelf = [];
  for (const root of roots) {
    for (const reply of root.replies) {
      if (reply.isSelf) continue;
      const targetsSelf = (Number(selfUin) > 0 && reply.replyToUin === Number(selfUin))
        || (selfNickname && reply.replyToNick === selfNickname)
        || (root.isSelf && !reply.replyToUin && !reply.replyToNick);
      if (targetsSelf) {
        repliesToSelf.push({ ...reply, rootUin: root.uin, rootNick: root.nick, rootText: root.text });
      }
    }
  }
  return { roots, repliesToSelf };
}

/** 评论的稳定指纹：用于判断“这条回复我处理过没有”。 */
export function qzoneCommentSignature(item) {
  return `${Number(item?.uin) || 0}:${String(item?.timeText ?? '')}:${String(item?.text ?? '')}`;
}

/** 北京时间的活跃窗口（默认 8–23 点）。start===end 表示全天。 */
export function qzoneSocialWindowOpen(now = Date.now(), cfg = {}) {
  const c = normalizeQzoneSocialConfig(cfg);
  const hour = beijingHour(now);
  if (hour === null) return false;
  const start = c.activeStartHour;
  const end = c.activeEndHour;
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** 下一次活跃窗口开始的 epoch ms；当前已在窗口内则返回 now。 */
export function nextQzoneSocialWindowStart(now = Date.now(), cfg = {}) {
  const c = normalizeQzoneSocialConfig(cfg);
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return NaN;
  if (qzoneSocialWindowOpen(nowMs, c)) return nowMs;
  const shifted = new Date(nowMs + BJ_OFFSET_MS);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const todayStart = dayStartShifted + c.activeStartHour * HOUR_MS - BJ_OFFSET_MS;
  if (nowMs < todayStart) return todayStart;
  return todayStart + DAY_MS;
}

/** 两次检查之间的随机间隔（只在没有固定时段时兜底）。 */
export function nextQzoneSocialCheckMs(cfg = {}, random = Math.random) {
  const c = normalizeQzoneSocialConfig(cfg);
  const r = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(c.checkMinMs + r * (c.checkMaxMs - c.checkMinMs));
}

/**
 * 下一次固定检查时刻（默认每天 10:00 / 22:00，北京时间）。
 * 已经过了今天的最后一个时段就排到明天第一个时段；没有合法时段时退回随机间隔。
 */
export function nextQzoneSocialCheckAt(now = Date.now(), cfg = {}) {
  const c = normalizeQzoneSocialConfig(cfg);
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return NaN;
  const times = c.checkTimes;
  if (!Array.isArray(times) || !times.length) return nowMs + nextQzoneSocialCheckMs(c);
  const shifted = new Date(nowMs + BJ_OFFSET_MS);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  for (const minutes of times) {
    const at = dayStartShifted + minutes * MINUTE_MS - BJ_OFFSET_MS;
    if (at > nowMs + 1000) return at;
  }
  const first = Math.min(...times);
  return dayStartShifted + DAY_MS + first * MINUTE_MS - BJ_OFFSET_MS;
}

/** 北京日期键：YYYY-MM-DD。 */
export function qzoneSocialDailyKey(now = Date.now()) {
  const ms = toMs(now);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + BJ_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 互动的每日限额。kind = 'like' | 'comment'。
 * 限额 0 表示不限。
 */
export function checkQzoneSocialQuota(state, cfg = {}, { uin = 0, kind = 'like', now = Date.now() } = {}) {
  const c = normalizeQzoneSocialConfig(cfg);
  const k = kind === 'comment' ? 'comments' : 'likes';
  const day = qzoneSocialDailyKey(now);
  const daily = state?.daily?.[day] ?? {};
  const usedGlobal = Math.max(0, Number(daily[k]) || 0);
  const limitGlobal = kind === 'comment' ? c.maxCommentsPerDay : c.maxLikesPerDay;
  if (limitGlobal > 0 && usedGlobal >= limitGlobal) {
    return { ok: false, reason: 'global-day', used: usedGlobal, limit: limitGlobal };
  }
  const friend = state?.perFriend?.[day]?.[String(Number(uin) || 0)] ?? {};
  const usedFriend = Math.max(0, Number(friend[k]) || 0);
  const limitFriend = kind === 'comment' ? c.maxCommentsPerFriendPerDay : c.maxLikesPerFriendPerDay;
  if (limitFriend > 0 && usedFriend >= limitFriend) {
    return { ok: false, reason: 'friend-day', used: usedFriend, limit: limitFriend };
  }
  // 全局节奏：概率闸之外再加最小间隔，避免一天的量在头几次检查里打光。
  const nowMs = toMs(now);
  const lastAt = kind === 'comment' ? Number(state?.lastCommentAt) || 0 : Number(state?.lastLikeAt) || 0;
  const minInterval = kind === 'comment' ? c.commentMinIntervalMs : c.likeMinIntervalMs;
  if (Number.isFinite(nowMs) && minInterval > 0 && lastAt > 0 && nowMs - lastAt < minInterval) {
    return {
      ok: false,
      reason: 'min-interval',
      used: usedGlobal,
      limit: limitGlobal,
      retryAfterMs: lastAt + minInterval - nowMs
    };
  }
  return { ok: true, reason: 'ok', used: usedGlobal, limit: limitGlobal };
}

/**
 * 追评限额：有人回复机器人的评论后，是否还能再回一句。
 * 追评也占全局评论日额，但有独立的每日/每帖上限和最小间隔。
 */
export function checkQzoneSocialFollowUpQuota(state, cfg = {}, { tid = '', now = Date.now() } = {}) {
  const c = normalizeQzoneSocialConfig(cfg);
  const nowMs = toMs(now);
  const day = qzoneSocialDailyKey(now);
  const daily = state?.daily?.[day] ?? {};
  const commentsUsed = Math.max(0, Number(daily.comments) || 0);
  if (c.maxCommentsPerDay > 0 && commentsUsed >= c.maxCommentsPerDay) {
    return { ok: false, reason: 'global-day', used: commentsUsed, limit: c.maxCommentsPerDay };
  }
  const followUpsUsed = Math.max(0, Number(daily.followUps) || 0);
  if (c.maxFollowUpsPerDay > 0 && followUpsUsed >= c.maxFollowUpsPerDay) {
    return { ok: false, reason: 'followup-day', used: followUpsUsed, limit: c.maxFollowUpsPerDay };
  }
  const entry = state?.seen?.[tid] ?? {};
  const perPost = Math.max(0, Number(entry.followUpCount) || 0);
  if (c.maxFollowUpsPerPost > 0 && perPost >= c.maxFollowUpsPerPost) {
    return { ok: false, reason: 'followup-post', used: perPost, limit: c.maxFollowUpsPerPost };
  }
  const lastAt = Math.max(0, Number(entry.lastFollowUpAt) || 0, Number(entry.commentedAt) || 0);
  if (Number.isFinite(nowMs) && c.followUpMinIntervalMs > 0 && lastAt > 0 && nowMs - lastAt < c.followUpMinIntervalMs) {
    return { ok: false, reason: 'min-interval', retryAfterMs: lastAt + c.followUpMinIntervalMs - nowMs };
  }
  return { ok: true, reason: 'ok', used: followUpsUsed, limit: c.maxFollowUpsPerDay };
}

/** 按概率决定是否行动；p<=0 永不，p>=1 必做。 */
export function rollQzoneSocial(probability, random = Math.random) {
  const p = clampNumber(probability, 0, 0, 1);
  if (p <= 0) return false;
  if (p >= 1) return true;
  const r = Math.max(0, Math.min(1, Number(random()) || 0));
  return r < p;
}

/** 解析模型返回的评论 JSON，兼容代码块/前后寒暄/字段别名。 */
export function parseQzoneCommentJson(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty' };
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no-json' };
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, error: 'bad-json' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'bad-json' };
  const skip = obj.skip === true || String(obj.skip).toLowerCase() === 'true';
  if (skip) {
    return { ok: true, skip: true, reason: truncateCodePoints(String(obj.reason ?? ''), 200) };
  }
  const comment = obj.comment ?? obj.text ?? obj.content;
  if (typeof comment !== 'string' || !comment.trim()) return { ok: false, error: 'no-comment' };
  return { ok: true, skip: false, comment: comment.trim() };
}

/** 评论内容校验：长度 + 隐私 + URL/@ + AI 味。 */
export function validateQzoneComment(text, cfg = {}) {
  const c = normalizeQzoneSocialConfig(cfg);
  const normalized = normalizeCommentText(text);
  if (!normalized) return { ok: false, error: 'empty' };
  const length = Array.from(normalized).length;
  if (length < c.commentMinChars) return { ok: false, error: 'too-short', length, minChars: c.commentMinChars };
  if (length > c.commentMaxChars) return { ok: false, error: 'too-long', length, maxChars: c.commentMaxChars };
  if (/(?:https?:\/\/|www\.)/i.test(normalized)) return { ok: false, error: 'url' };
  if (/@/.test(normalized)) return { ok: false, error: 'at' };
  if (/(?:作为(?:一个)?\s*AI|我是(?:AI|人工智能)|人工智能|语言模型|客服|希望对你有帮助|有什么可以帮|祝你(?:生活|今天|天天))/i.test(normalized)) {
    return { ok: false, error: 'ai-tone' };
  }
  const violations = findQzonePrivacyViolations(normalized);
  if (violations.length) return { ok: false, error: 'privacy', violations };
  return { ok: true, text: normalized, length };
}

/**
 * 归一化并清理持久化状态。就地修改并返回 state。
 * seen 按说说发布时间保留 seenTtlMs，最多 maxSeen 条；daily/perFriend 保留 7 天。
 */
export function pruneQzoneSocialState(state, now = Date.now()) {
  if (!state || typeof state !== 'object') return state;
  const c = normalizeQzoneSocialConfig(state);
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return state;
  if (state.pendingComment && Number(state.pendingComment.expiresAt) <= nowMs) {
    state.pendingComment = null;
  }
  if (state.lastQuery && Number(state.lastQuery.expiresAt) <= nowMs) {
    state.lastQuery = null;
  }
  const cutoff = nowMs - c.seenTtlMs;
  const kept = [];
  for (const [tid, entry] of Object.entries(state.seen ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const timeMs = (Number(entry.time) || 0) * 1000;
    if (!timeMs || timeMs < cutoff) continue;
    if (!/^[0-9a-f]{16,40}$/i.test(String(tid))) continue;
    kept.push([tid, entry]);
  }
  kept.sort((a, b) => (Number(b[1].time) || 0) - (Number(a[1].time) || 0));
  state.seen = Object.fromEntries(kept.slice(0, c.maxSeen));
  for (const entry of Object.values(state.seen)) {
    if (entry && Array.isArray(entry.handledReplies)) {
      entry.handledReplies = entry.handledReplies.filter((x) => typeof x === 'string').slice(-10);
    }
  }

  const dayMs = 7 * DAY_MS;
  for (const key of ['daily', 'perFriend']) {
    const map = state[key];
    if (!map || typeof map !== 'object') { state[key] = {}; continue; }
    for (const day of Object.keys(map)) {
      const parsed = Date.parse(`${day}T00:00:00+08:00`);
      if (!Number.isFinite(parsed) || parsed < nowMs - dayMs) delete map[day];
    }
  }
  if (Array.isArray(state.recentComments)) {
    state.recentComments = state.recentComments
      .filter((item) => item && typeof item.text === 'string')
      .slice(-20);
  } else {
    state.recentComments = [];
  }
  return state;
}

function normalizeQzoneFeedQueryResult(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const expiresAt = Math.max(0, Number(raw.expiresAt) || 0);
  if (!id || !expiresAt || expiresAt <= now) return null;
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((item, i) => ({
      index: i + 1,
      tid: truncateCodePoints(String(item?.tid ?? ''), 80),
      uin: Math.max(0, Number(item?.uin) || 0),
      nickname: truncateCodePoints(String(item?.nickname ?? ''), 60),
      time: Math.max(0, Number(item?.time) || 0),
      text: truncateCodePoints(String(item?.text ?? ''), 160),
      commentNum: Math.max(0, Number(item?.commentNum) || 0)
    }))
    .filter((item) => item.tid);
  if (!items.length) return null;
  return {
    id: truncateCodePoints(id, 40),
    createdAt: Math.max(0, Number(raw.createdAt) || 0),
    expiresAt,
    who: truncateCodePoints(String(raw.who ?? 'all'), 60),
    from: Math.max(0, Number(raw.from) || 0),
    to: Math.max(0, Number(raw.to) || 0),
    limit: Math.min(50, Math.max(1, Number(raw.limit) || 10)),
    items: items.slice(0, 50)
  };
}

function normalizePendingQzoneComment(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const tid = String(raw.tid ?? '').trim();
  const comment = String(raw.comment ?? '').trim();
  if (!id || !tid || !comment) return null;
  const createdAt = Math.max(0, Number(raw.createdAt) || 0);
  const expiresAt = Math.max(0, Number(raw.expiresAt) || 0);
  if (!expiresAt || expiresAt <= now) return null;
  return {
    id: truncateCodePoints(id, 40),
    kind: raw.kind === 'followup' ? 'followup' : 'comment',
    tid: truncateCodePoints(tid, 80),
    uin: Math.max(0, Number(raw.uin) || 0),
    nickname: truncateCodePoints(String(raw.nickname ?? ''), 60),
    text: truncateCodePoints(String(raw.text ?? ''), 160),
    comment: truncateCodePoints(comment, 100),
    ourComment: truncateCodePoints(String(raw.ourComment ?? ''), 100),
    replyNick: truncateCodePoints(String(raw.replyNick ?? ''), 60),
    replyText: truncateCodePoints(String(raw.replyText ?? ''), 200),
    handledSigs: Array.isArray(raw.handledSigs)
      ? raw.handledSigs.filter((x) => typeof x === 'string').slice(-10)
      : [],
    forced: raw.forced === true,
    createdAt,
    expiresAt
  };
}

/**
 * owner 对待确认评论的回复：
 *   [评论确认] / [评论取消] / [评论修改] 新内容
 * 兼容全角括号【】。
 */
export function parseQzoneCommentApprovalIntent(text) {
  const s = String(text ?? '').trim().replace(/【/g, '[').replace(/】/g, ']');
  if (!s) return { ok: false };
  const compact = s.replace(/\s+/g, '');

  // 查看待处理：提案 + 发送失败/结果未知的评论
  if (/^\[?(?:查看)?待处理评论\]?$/.test(compact)
    || /^\[?评论队列\]?$/.test(compact)
    || /^\[?待评论列表\]?$/.test(compact)) {
    return { ok: true, action: 'list' };
  }

  const normalizeId = (value) => {
    const id = String(value ?? '').trim();
    if (!id) return '';
    return /^(?:c_[0-9a-z]+|fc_[0-9a-z]+|fu_[0-9a-z]+|\d{1,3})$/i.test(id) ? id : '';
  };

  // 确认/取消标签的方括号必须保留，避免和正常聊天「评论确认一下」撞车。
  const parseTagged = (tag) => {
    const inside = s.match(new RegExp(`^\\[${tag}\\s*([^\\]\\s]*)\\s*\\]$`));
    if (inside) {
      const raw = String(inside[1] ?? '').trim();
      const id = normalizeId(raw);
      if (raw && !id) return false;
      return { ok: true, id };
    }
    const outside = s.match(new RegExp(`^\\[${tag}\\]\\s*([^\\]]+)$`));
    if (outside) {
      const raw = String(outside[1] ?? '').trim();
      const id = normalizeId(raw);
      if (!id) return false;
      return { ok: true, id };
    }
    return null;
  };
  let tagged = parseTagged('(?:待)?评论确认');
  if (tagged) return { ok: true, action: 'confirm', id: tagged.id || '' };
  tagged = parseTagged('(?:待)?评论取消');
  if (tagged) return { ok: true, action: 'cancel', id: tagged.id || '' };
  const m = s.match(/^\[(?:待)?评论修改\]\s*([\s\S]+)$/);
  if (m && m[1].trim()) return { ok: true, action: 'modify', text: m[1].trim() };
  return { ok: false };
}

/** 读取/首次创建时的状态归一化：运行期开关优先，其余从 config 播种。 */
export function normalizeQzoneSocialState(raw = {}, cfg = {}) {
  const c = normalizeQzoneSocialConfig(cfg);
  const r = raw && typeof raw === 'object' ? raw : {};
  const state = {
    enabled: r.enabled === undefined ? c.enabled === true : r.enabled === true,
    likeEnabled: r.likeEnabled === undefined ? c.likeEnabled !== false : r.likeEnabled !== false,
    commentEnabled: r.commentEnabled === undefined ? c.commentEnabled !== false : r.commentEnabled !== false,
    requireCommentApproval: r.requireCommentApproval === undefined
      ? c.requireCommentApproval !== false
      : r.requireCommentApproval !== false,
    pendingComment: normalizePendingQzoneComment(r.pendingComment, Date.now()),
    lastQuery: normalizeQzoneFeedQueryResult(r.lastQuery, Date.now()),
    selfUin: Math.max(0, Number(r.selfUin) || 0),
    seen: {},
    recentComments: [],
    daily: {},
    perFriend: {},
    lastLikeAt: Math.max(0, Number(r.lastLikeAt) || 0),
    lastCommentAt: Math.max(0, Number(r.lastCommentAt) || 0),
    lastCheckAt: Math.max(0, Number(r.lastCheckAt) || 0),
    nextCheckAt: Math.max(0, Number(r.nextCheckAt) || 0),
    lastError: truncateCodePoints(String(r.lastError ?? ''), 200),
    updatedAt: Math.max(0, Number(r.updatedAt) || 0)
  };
  for (const [tid, entry] of Object.entries(r.seen ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    state.seen[tid] = {
      uin: Math.max(0, Number(entry.uin) || 0),
      nickname: truncateCodePoints(String(entry.nickname ?? ''), 60),
      time: Math.max(0, Number(entry.time) || 0),
      text: truncateCodePoints(String(entry.text ?? ''), 160),
      likedAt: Math.max(0, Number(entry.likedAt) || 0),
      commentedAt: Math.max(0, Number(entry.commentedAt) || 0),
      comment: truncateCodePoints(String(entry.comment ?? ''), 100),
      commentId: truncateCodePoints(String(entry.commentId ?? ''), 40),
      commentDeletedAt: Math.max(0, Number(entry.commentDeletedAt) || 0),
      commentProposedAt: Math.max(0, Number(entry.commentProposedAt) || 0),
      commentCancelledAt: Math.max(0, Number(entry.commentCancelledAt) || 0),
      handledReplies: Array.isArray(entry.handledReplies)
        ? entry.handledReplies.filter((x) => typeof x === 'string').slice(-10)
        : [],
      followUpCount: Math.max(0, Number(entry.followUpCount) || 0),
      lastFollowUpAt: Math.max(0, Number(entry.lastFollowUpAt) || 0),
      lastFollowUpText: truncateCodePoints(String(entry.lastFollowUpText ?? ''), 100),
      commentDismissedAt: Math.max(0, Number(entry.commentDismissedAt) || 0),
      error: truncateCodePoints(String(entry.error ?? ''), 200)
    };
  }
  for (const [day, counts] of Object.entries(r.daily ?? {})) {
    if (!counts || typeof counts !== 'object') continue;
    state.daily[day] = {
      likes: Math.max(0, Number(counts.likes) || 0),
      comments: Math.max(0, Number(counts.comments) || 0),
      followUps: Math.max(0, Number(counts.followUps) || 0)
    };
  }
  for (const [day, friends] of Object.entries(r.perFriend ?? {})) {
    if (!friends || typeof friends !== 'object') continue;
    const out = {};
    for (const [uin, counts] of Object.entries(friends)) {
      if (!counts || typeof counts !== 'object') continue;
      out[uin] = {
        likes: Math.max(0, Number(counts.likes) || 0),
        comments: Math.max(0, Number(counts.comments) || 0)
      };
    }
    state.perFriend[day] = out;
  }
  if (Array.isArray(r.recentComments)) {
    state.recentComments = r.recentComments
      .filter((item) => item && typeof item.text === 'string')
      .map((item) => ({ text: truncateCodePoints(item.text, 100), at: Math.max(0, Number(item.at) || 0) }))
      .slice(-20);
  }
  return pruneQzoneSocialState(state, Date.now());
}
