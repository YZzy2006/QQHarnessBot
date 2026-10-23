// owner 只读查看指令：纯解析/格式化，不做文件/网络 I/O。
//
// 六组指令：
//   [今日用量] / [服务器] / [群信息 <群号>] / [群公告 <群号>] /
//   [标记已读 <号码>] / [查看转发 <id>]
//
// 三条约束：
// 1. 解析只做字符串归一化，取数据与发送都由 bridge 负责；这里只把「文本 + 数据」变成「文本」。
// 2. 金额一律走 model-prices.js 的价目表，不在这里另抄一份单价，避免两边算出不同的钱。
// 3. 字段缺失一律降级成「未知」，绝不抛异常：这些指令跑在 QQ 消息路径上，
//    抛错会变成一条「处理失败」的回复，比缺字段更糟。
import {
  DEFAULT_PRICE_TABLE,
  ZERO_BUCKETS,
  addBuckets,
  beijingParts,
  normalizeUsage,
  priceUsage,
  totalTokensOf
} from './model-prices.js';
import { formatForwardResponse, nodeText } from './forward.js';
import { bracketSegments } from './command-args.js';

/** 只读查看指令的用法。 */
export const INSPECT_HELP = [
  '【查看 · 用法】',
  '  [今日用量]                      今天的 token 用量与估算花费',
  '  [服务器]                        负载、内存、磁盘与运行时长',
  '  [群信息 7000001]             群名称、成员、群主、创建时间',
  '  [群公告 7000001]             最近 5 条群公告',
  '  [群荣誉 7000001]             群荣誉榜（龙王/群聊之火等）',
  '  [@全体剩余 7000001]          @全体成员剩余次数',
  '  [标记已读 7000001]           标记私聊/群为已读',
  '  [查看转发 <id>]                 查看合并转发的文字内容',
  '',
  '群号也可以换成群名：[群信息][测试群聊]；重名时会拒绝并列候选，改用群号即可。',
  '发 [指令] 查看全部指令。'
].join('\n');

// ── 解析 ──────────────────────────────────────────────────────────────────

/**
 * 指令归一化：去掉【】[]、把冒号当分隔符、压缩空白。
 * 群号/QQ 与关键字之间有没有空格都能认，所以匹配时再去掉一次空白。
 */
function normalizeCommand(text) {
  return String(text ?? '')
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const USAGE_RE = /^(?:今日用量|今日成本|今日花费|今日消耗|今日消费|今天用量|今天的用量|成本|用量|花费)$/i;
const SERVER_RE = /^(?:服务器|服务器状态|系统状态|机器状态|主机状态|资源|资源占用)$/i;
const GROUP_INFO_RE = /^(?:查看群信息|群信息|群资料|查群|群详情)(\d{5,12})?$/i;
const GROUP_NOTICE_RE = /^(?:查看群公告|群公告|群通知)(\d{5,12})?$/i;
const GROUP_HONOR_RE = /^(?:查看群荣誉|群荣誉信息|群荣誉)(\d{5,12})?$/i;
// 「@全体剩余」在归一化后可能带 @，也可能被写成「全体剩余」。
const AT_ALL_REMAIN_RE = /^(?:@?全体剩余|@全体成员剩余|at全体剩余)(\d{5,12})?$/i;
const MARK_READ_RE = /^(?:标记群已读|标记私聊已读|标记已读|已读)(\d{5,12})?$/i;
// forward id 只允许安全字符，与 forward.js 的清洗规则保持一致。
const FORWARD_RE = /^(?:看转发|查看转发|转发详情|转发内容)([\w:.\-/=+@]{1,256})?$/i;

/** 分段写法里，把「群号或群名」变成 groupId / groupText。 */
function groupTarget(action, rest) {
  const t = String(rest ?? '').trim();
  if (!t) return { ok: true, action, groupId: 0 };
  if (/^\d{5,12}$/.test(t)) return { ok: true, action, groupId: Number(t) };
  // 全数字但位数不对：当格式错误，不当群名。
  if (/^\d+$/.test(t)) return { ok: true, action, groupId: 0 };
  return { ok: true, action, groupId: 0, groupText: t };
}

/**
 * 解析分段写法：[群信息][测试群聊] / [群荣誉][7000001]。
 * 单段写法仍走原来的空格/数字匹配，避免把普通聊天误判成群名。
 */
function parseSegmented(segments) {
  const head = String(segments[0] ?? '').replace(/[：:]$/, '').replace(/\s+/g, '');
  const rest = segments.slice(1).join(' ').trim();
  if (!head) return null;

  if (/^(?:今日用量|今日成本|今日花费|今日消耗|今日消费|今天用量|今天的用量|成本|用量|花费)$/i.test(head)) {
    return { ok: true, action: 'usage' };
  }
  if (/^(?:服务器|服务器状态|系统状态|机器状态|主机状态|资源|资源占用)$/i.test(head)) {
    return { ok: true, action: 'server' };
  }
  if (/^(?:查看帮助|查看指令|只读指令|查看用法)$/.test(head)) {
    return { ok: true, action: 'help' };
  }
  if (/^(?:查看群信息|群信息|群资料|查群|群详情)$/i.test(head)) {
    return groupTarget('groupInfo', rest);
  }
  if (/^(?:查看群公告|群公告|群通知)$/i.test(head)) {
    return groupTarget('groupNotice', rest);
  }
  if (/^(?:查看群荣誉|群荣誉信息|群荣誉)$/i.test(head)) {
    return groupTarget('groupHonor', rest);
  }
  if (/^(?:@?全体剩余|@全体成员剩余|at全体剩余)$/i.test(head)) {
    return groupTarget('atAllRemain', rest);
  }
  if (/^(?:标记群已读|标记私聊已读|标记已读|已读)$/i.test(head)) {
    const t = rest;
    if (!t) return { ok: true, action: 'markRead', targetId: 0 };
    if (/^\d{5,12}$/.test(t)) return { ok: true, action: 'markRead', targetId: Number(t) };
    if (/^\d+$/.test(t)) return { ok: true, action: 'markRead', targetId: 0 };
    return { ok: true, action: 'markRead', targetId: 0, targetText: t };
  }
  if (/^(?:看转发|查看转发|转发详情|转发内容)$/i.test(head)) {
    return { ok: true, action: 'forward', forwardId: rest };
  }
  return null;
}

/**
 * 解析 owner 只读指令。
 * @returns {{ok:false}|{ok:true, action:string, groupId?:number, groupText?:string,
 *   targetId?:number, targetText?:string, forwardId?:string}}
 */
export function parseOwnerInspectCommand(text) {
  const segments = bracketSegments(text);
  if (segments) {
    const parsed = parseSegmented(segments);
    if (parsed) return parsed;
  }

  const s = normalizeCommand(text);
  if (!s) return { ok: false };
  const compact = s.replace(/\s+/g, '');
  if (!compact) return { ok: false };

  if (USAGE_RE.test(compact)) return { ok: true, action: 'usage' };
  if (SERVER_RE.test(compact)) return { ok: true, action: 'server' };
  if (/^(?:查看帮助|查看指令|只读指令|查看用法)$/.test(compact)) return { ok: true, action: 'help' };

  let m = compact.match(GROUP_INFO_RE);
  if (m) return { ok: true, action: 'groupInfo', groupId: m[1] ? Number(m[1]) : 0 };

  m = compact.match(GROUP_NOTICE_RE);
  if (m) return { ok: true, action: 'groupNotice', groupId: m[1] ? Number(m[1]) : 0 };

  m = compact.match(GROUP_HONOR_RE);
  if (m) return { ok: true, action: 'groupHonor', groupId: m[1] ? Number(m[1]) : 0 };

  m = compact.match(AT_ALL_REMAIN_RE);
  if (m) return { ok: true, action: 'atAllRemain', groupId: m[1] ? Number(m[1]) : 0 };

  m = compact.match(MARK_READ_RE);
  if (m) return { ok: true, action: 'markRead', targetId: m[1] ? Number(m[1]) : 0 };

  m = compact.match(FORWARD_RE);
  if (m) return { ok: true, action: 'forward', forwardId: m[1] ?? '' };

  // 单段但命令和数据之间有空格/冒号：支持 [群信息 测试群] 这种写法。
  // 不匹配「群信息很重要」这类没有分隔符的普通语句。
  // 全数字但位数不对（如 13 位）视为格式错误，不降级成群名。
  const spacedTarget = (action, rest) => {
    const t = String(rest ?? '').trim();
    if (/^\d+$/.test(t) && !/^\d{5,12}$/.test(t)) return null;
    return groupTarget(action, t);
  };
  let spaced = s.match(/^(?:查看群信息|群信息|群资料|查群|群详情)\s+(.+)$/i);
  if (spaced) {
    const parsed = spacedTarget('groupInfo', spaced[1]);
    if (parsed) return parsed;
  }
  spaced = s.match(/^(?:查看群公告|群公告|群通知)\s+(.+)$/i);
  if (spaced) {
    const parsed = spacedTarget('groupNotice', spaced[1]);
    if (parsed) return parsed;
  }
  spaced = s.match(/^(?:查看群荣誉|群荣誉信息|群荣誉)\s+(.+)$/i);
  if (spaced) {
    const parsed = spacedTarget('groupHonor', spaced[1]);
    if (parsed) return parsed;
  }
  spaced = s.match(/^(?:@?全体剩余|@全体成员剩余|at全体剩余)\s+(.+)$/i);
  if (spaced) {
    const parsed = spacedTarget('atAllRemain', spaced[1]);
    if (parsed) return parsed;
  }
  spaced = s.match(/^(?:标记群已读|标记私聊已读|标记已读|已读)\s+(.+)$/i);
  if (spaced) {
    const t = spaced[1].trim();
    if (/^\d+$/.test(t) && !/^\d{5,12}$/.test(t)) return { ok: false };
    return /^\d{5,12}$/.test(t)
      ? { ok: true, action: 'markRead', targetId: Number(t) }
      : { ok: true, action: 'markRead', targetId: 0, targetText: t };
  }

  return { ok: false };
}

// ── 通用格式化小工具 ──────────────────────────────────────────────────────

function toMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** 千分位整数（不依赖运行机器的 locale）。 */
function thousands(value) {
  const n = Math.round(Number(value) || 0);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 北京时间的 YYYY-MM-DD HH:mm。 */
function bjDateTime(ms) {
  const t = toMs(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const p = beijingParts(t);
  return `${p.date} ${p.clock}`;
}

/** 金额：4 位小数；不足 0.0001 时显示 <¥0.0001。 */
function fmtMoney(value, table) {
  const symbol = table?.symbol || '¥';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${symbol}0.0000`;
  if (n < 0.0001) return `<${symbol}0.0001`;
  return `${symbol}${n.toFixed(4)}`;
}

function fmtGb(bytes) {
  return (Number(bytes) / (1024 ** 3)).toFixed(1);
}

/** 「X天X小时X分」；缺失或非法值返回「未知」。 */
function fmtUptime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  const total = Math.floor(n);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return `${days}天${hours}小时${mins}分`;
}

/** 把空白（含换行）压成单个空格：公告/转发的正文都要保持单行可读。 */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 按字符截断，切点落在代理对中间时前移一个码元。 */
function truncateText(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) return { text: s, truncated: false };
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  if (cut <= 0) cut = Math.min(2, s.length);
  return { text: s.slice(0, cut), truncated: true };
}

function pickText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return '';
}

function pickCount(...values) {
  for (const value of values) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return String(Math.trunc(n));
  }
  return '';
}

/** 群号/QQ 号原样保留（含负数、字符串），缺省显示「未知」。 */
function pickId(value) {
  if (value === null || value === undefined) return '未知';
  const s = String(value).trim();
  if (!s || s === '0') return '未知';
  return s;
}

/** 秒级时间戳按 10 位、毫秒级按 13 位识别；其它长度视为未知。 */
function normalizeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  const digits = String(Math.trunc(n)).length;
  if (digits === 10) return n * 1000;
  if (digits === 13) return n;
  return NaN;
}

/** OneBot 的 time 通常是秒，但测试/转发节点里也可能是毫秒。 */
function timeToMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n > 1e12 ? n : n * 1000;
}

// ── 今日用量 ──────────────────────────────────────────────────────────────

/** 接受 JSONL 字符串或已解析数组；坏行/半行直接跳过。 */
function toRecordArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch {
      // 进程中断留下的半行：跳过即可，不必让整条指令失败。
    }
  }
  return out;
}

/**
 * 今日用量汇总。
 *
 * 只统计 `k === 'turn'`：`base` 是整条会话的累计投影、`evict` 是被淘汰采样的累计，
 * 把它们算进「今天」会把历史总量重复计一遍（金额直接翻几倍）。
 */
export function formatTodayUsage(raw, { now = Date.now(), priceTable = DEFAULT_PRICE_TABLE } = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const table = priceTable ?? DEFAULT_PRICE_TABLE;
  const today = beijingParts(nowMs).date;
  const generatedAt = beijingParts(nowMs).clock;

  let buckets = { ...ZERO_BUCKETS };
  let cost = 0;
  let estimated = false;
  let samples = 0;
  // 同一条 turn 可能因多步工具调用产生多条采样；回合数要按 sid|turn 去重，
  // 否则一次对话里有 3 次工具调用就会被报成 3 个回合。
  const turnSeen = new Set();
  const byModel = new Map();
  const byKey = new Map();

  for (const rec of toRecordArray(raw)) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.k !== 'turn') continue;
    const at = Number(rec.t);
    if (!Number.isFinite(at)) continue;
    // 必须按北京时间判「今天」，不能用运行机器的本地时区。
    if (beijingParts(at).date !== today) continue;

    const b = normalizeUsage(rec.b);
    const priced = priceUsage(b, { model: rec.model, at, table });
    buckets = addBuckets(buckets, b);
    cost += priced.cost.total;
    estimated ||= priced.rates.estimated;
    samples += 1;
    if (rec.turn !== null && rec.turn !== undefined && rec.turn !== '') {
      turnSeen.add(`${rec.sid ?? rec.key ?? ''}|${rec.turn}`);
    }

    const modelName = String(rec.model ?? '').trim();
    const modelRowKey = modelName || '未标注模型';
    let modelRow = byModel.get(modelRowKey);
    if (!modelRow) {
      modelRow = {
        model: modelRowKey,
        label: String(priced.rates.label ?? ''),
        buckets: { ...ZERO_BUCKETS },
        cost: 0,
        estimated: false
      };
      byModel.set(modelRowKey, modelRow);
    }
    modelRow.buckets = addBuckets(modelRow.buckets, b);
    modelRow.cost += priced.cost.total;
    modelRow.estimated ||= priced.rates.estimated;

    const keyText = String(rec.key ?? '').trim() || '未归属';
    let keyRow = byKey.get(keyText);
    if (!keyRow) {
      keyRow = { key: keyText, buckets: { ...ZERO_BUCKETS }, cost: 0 };
      byKey.set(keyText, keyRow);
    }
    keyRow.buckets = addBuckets(keyRow.buckets, b);
    keyRow.cost += priced.cost.total;
  }

  if (samples === 0) return '今日还没有用量记录。';

  const totalTokens = totalTokensOf(buckets);
  const inputTokens = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  const countText = `${thousands(samples)} 次计费请求${turnSeen.size ? ` / ${thousands(turnSeen.size)} 个回合` : ''}`;
  const lines = [
    '【今日用量】',
    `北京日期：${today} · 生成时刻：${generatedAt}`,
    `总 token：${thousands(totalTokens)}（${countText}）`,
    `输入：${thousands(inputTokens)}（命中 ${thousands(buckets.cacheHit)} / 未命中 ${thousands(buckets.cacheMiss)} / 写入 ${thousands(buckets.cacheWrite)}）`,
    `输出：${thousands(buckets.output)}${buckets.reasoning > 0 ? `（其中推理 ${thousands(buckets.reasoning)}，不计入总量）` : ''}`,
    `估算花费：${fmtMoney(cost, table)}${estimated ? '（含估算价）' : ''}`,
    '',
    '按模型：'
  ];

  const modelRows = [...byModel.values()].sort((a, b) => b.cost - a.cost || totalTokensOf(b.buckets) - totalTokensOf(a.buckets));
  for (const row of modelRows) {
    const tokens = totalTokensOf(row.buckets);
    const name = row.model === '未标注模型'
      ? row.model
      : (row.label && row.label !== row.model ? `${row.label}（${row.model}）` : row.model);
    const note = row.estimated ? '（未收录，含估算价）' : '';
    lines.push(`  ${name}：${thousands(tokens)} token · ${fmtMoney(row.cost, table)}${note}`);
  }

  lines.push('', '按会话：');
  const keyRows = [...byKey.values()].sort((a, b) => b.cost - a.cost || totalTokensOf(b.buckets) - totalTokensOf(a.buckets));
  for (const row of keyRows.slice(0, 5)) {
    lines.push(`  ${row.key}：${thousands(totalTokensOf(row.buckets))} token · ${fmtMoney(row.cost, table)}`);
  }

  return lines.join('\n');
}

// ── 服务器 ────────────────────────────────────────────────────────────────

/**
 * 服务器状态。`statfs` 只代表传入的那一个分区（bridge 传 '/'），
 * 所以磁盘行要写明「仅该分区」，否则会被误读成整机的磁盘占用。
 */
export function formatServerStats({
  loadavg = [],
  cpuCount = 0,
  totalmem = 0,
  freemem = 0,
  statfs = null,
  processUptimeSec = 0,
  hostUptimeSec = 0,
  now = Date.now()
} = {}) {
  void now; // 保留参数位：调用方统一传「统计时刻」，输出里不需要重复展示
  const load = Array.isArray(loadavg) ? loadavg : [];
  const loadText = (index) => {
    const n = Number(load[index]);
    return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : '未知';
  };
  const cores = Number(cpuCount) > 0 ? Math.round(Number(cpuCount)) : 0;
  const load1 = Number(load[0]);

  const lines = [
    '【服务器】',
    `负载：${loadText(0)} / ${loadText(1)} / ${loadText(2)}（1/5/15 分钟）`
  ];
  if (cores > 0) {
    const verdict = Number.isFinite(load1)
      ? (load1 > cores ? '1 分钟负载高于核数' : '1 分钟负载低于核数')
      : '无法对比核数';
    lines.push(`CPU：${cores} 核（${verdict}）`);
  } else {
    lines.push('CPU：未知');
  }

  const totalBytes = Number(totalmem);
  const freeBytes = Number(freemem);
  if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(freeBytes) && freeBytes > 0) {
    const used = Math.max(0, totalBytes - freeBytes);
    lines.push(`内存：${fmtGb(used)} / ${fmtGb(totalBytes)} GB（${((used / totalBytes) * 100).toFixed(1)}%）`);
  } else {
    lines.push('内存：未知');
  }

  const bsize = Number(statfs?.bsize);
  const blocks = Number(statfs?.blocks);
  const bavail = Number(statfs?.bavail);
  if (statfs && Number.isFinite(bsize) && Number.isFinite(blocks) && Number.isFinite(bavail)
    && bsize > 0 && blocks > 0 && bavail >= 0) {
    const diskTotal = bsize * blocks;
    const diskAvail = Math.min(diskTotal, bsize * bavail);
    const diskUsed = Math.max(0, diskTotal - diskAvail);
    lines.push(`磁盘（仅该分区）：${fmtGb(diskUsed)} / ${fmtGb(diskTotal)} GB（${((diskUsed / diskTotal) * 100).toFixed(1)}%）`);
  } else {
    lines.push('磁盘：未知');
  }

  lines.push(`桥接运行时长：${fmtUptime(processUptimeSec)}`);
  lines.push(`主机运行时长：${fmtUptime(hostUptimeSec)}`);
  return lines.join('\n');
}

// ── 群信息 ────────────────────────────────────────────────────────────────

/** 群资料：兼容 go-cqhttp / SnowLuma 的几套字段名。 */
export function formatGroupInfo(groupId, data) {
  const gid = String(groupId ?? '').trim() || '未知';
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [`【群信息】${gid}`, '读取群信息失败（权限不足或群号有误）。'].join('\n');
  }

  const name = pickText(data.group_name, data.name, data.groupName) || '未知';
  const members = pickCount(data.member_count, data.memberCount);
  const maxMembers = pickCount(data.max_member_count, data.maxMemberCount);
  const owner = pickId(data.owner_id ?? data.owner_uin ?? data.ownerId ?? data.owner?.user_id);
  const createMs = normalizeTimestamp(data.create_time ?? data.group_create_time ?? data.createTime);
  const shutRaw = data.group_all_shut ?? data.all_shut ?? data.groupAllShut;
  let shut = '未知';
  if (shutRaw !== null && shutRaw !== undefined) {
    const n = Number(shutRaw);
    if (shutRaw === true || n === 1) shut = '开启';
    else if (shutRaw === false || n === 0) shut = '关闭';
  }

  return [
    `【群信息】${gid}`,
    `群名称：${name}`,
    `群号：${gid}`,
    `成员：${members || '未知'} / ${maxMembers || '未知'}`,
    `群主：${owner}`,
    `创建时间：${Number.isFinite(createMs) ? bjDateTime(createMs) : '未知'}`,
    `全员禁言：${shut}`
  ].join('\n');
}

// ── 群公告 ────────────────────────────────────────────────────────────────

function noticeTextOf(notice) {
  const message = notice?.message && typeof notice.message === 'object' ? notice.message : {};
  const raw = message.text ?? notice?.text ?? '';
  if (Array.isArray(raw)) {
    return raw.map((seg) => (typeof seg === 'string' ? seg : String(seg?.data?.text ?? seg?.text ?? ''))).join('');
  }
  return String(raw ?? '');
}

function noticeImageCount(notice) {
  const message = notice?.message && typeof notice.message === 'object' ? notice.message : {};
  const images = message.images ?? notice?.images;
  if (Array.isArray(images)) return images.length;
  if (images && typeof images === 'object') return 1;
  const image = notice?.image ?? message.image;
  if (Array.isArray(image)) return image.length;
  if (image !== null && image !== undefined && image !== '') return 1;
  return 0;
}

/**
 * 群公告：只展示文字与图片数量，不下载图片（公告图往往带临时鉴权参数，
 * 而且一条指令不该触发多次网络请求）。
 */
export function formatGroupNotice(groupId, data) {
  const gid = String(groupId ?? '').trim() || '未知';
  const notices = Array.isArray(data)
    ? data
    : (Array.isArray(data?.notices) ? data.notices : []);
  if (!notices.length) return `群 ${gid} 暂无公告。`;

  const shown = notices.slice(0, 5);
  const lines = [`【群公告】${gid}`];
  if (notices.length > shown.length) lines.push(`共 ${notices.length} 条，只显示前 ${shown.length} 条：`);

  shown.forEach((notice, index) => {
    const item = notice && typeof notice === 'object' ? notice : {};
    const publishedMs = normalizeTimestamp(item.publish_time ?? item.publishTime ?? item.time ?? item.create_time);
    const publisher = pickText(item.publisher_id, item.sender_id, item.uin, item.user_id, item.qq) || '未知';
    const typeText = /新成员|new/i.test(String(item.notice_type ?? item.type ?? '')) ? '新成员公告' : '群公告';
    const { text: body, truncated } = truncateText(collapse(noticeTextOf(item)), 200);
    const imageCount = noticeImageCount(item);

    lines.push(`${index + 1}. ${Number.isFinite(publishedMs) ? bjDateTime(publishedMs) : '时间未知'} · QQ ${publisher} · ${typeText}`);
    if (body) lines.push(`   ${body}${truncated ? '…' : ''}`);
    if (imageCount > 0) lines.push(`   图片 ${imageCount} 张`);
  });

  return lines.join('\n');
}

// ── 群荣誉 ────────────────────────────────────────────────────────────────

// SnowLuma 的 get_group_honor_info 只填充这五类；strong_newbie_list 目前恒为空，
// 但仍按标准 OneBot 字段展示，避免换实现后漏掉。
const HONOR_SECTIONS = [
  ['talkative_list', '龙王'],
  ['performer_list', '群聊之火'],
  ['legend_list', '群聊炽焰'],
  ['emotion_list', '快乐源泉'],
  ['strong_newbie_list', '冒泡新星']
];

function honorWho(member) {
  const uid = String(member?.user_id ?? member?.uin ?? '').trim();
  const nick = pickText(member?.nickname, member?.name);
  if (nick && uid) return `${nick}(${uid})`;
  if (nick) return nick;
  return uid ? `QQ ${uid}` : '未知';
}

function honorLine(member, index) {
  const desc = pickText(member?.description, member?.desc);
  const parts = [`${index}. ${honorWho(member)}`];
  if (desc) parts.push(desc);
  return parts.join('｜');
}

/**
 * 群荣誉榜。data 形状：
 * {current_talkative, talkative_list, performer_list, legend_list, emotion_list, strong_newbie_list}
 * 每项为 {user_id,nickname,avatar,description}。
 */
export function formatGroupHonor(groupId, data, { perSection = 5 } = {}) {
  const gid = String(groupId ?? '').trim() || '未知';
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [`【群荣誉】${gid}`, '读取群荣誉失败（权限不足或群号有误）。'].join('\n');
  }

  const cap = Math.max(1, Math.min(20, Number(perSection) || 5));
  const lines = [`【群荣誉】${gid}`];
  let found = false;

  const current = data.current_talkative;
  if (current && typeof current === 'object') {
    found = true;
    lines.push(`当前龙王：${honorWho(current)}${pickText(current.description, current.desc) ? `｜${pickText(current.description, current.desc)}` : ''}`);
  }

  // current_talkative 通常就是 talkative_list[0]，列表里跳过它避免重复。
  const currentUid = String(current?.user_id ?? current?.uin ?? '').trim();
  for (const [field, label] of HONOR_SECTIONS) {
    const list = (Array.isArray(data[field]) ? data[field] : [])
      .filter((item) => item && typeof item === 'object')
      .filter((item) => !(field === 'talkative_list' && currentUid
        && String(item.user_id ?? item.uin ?? '').trim() === currentUid));
    if (!list.length) continue;

    found = true;
    lines.push(`${label}（${list.length}）：`);
    list.slice(0, cap).forEach((item, index) => lines.push(`  ${honorLine(item, index + 1)}`));
    if (list.length > cap) lines.push(`  只显示前 ${cap} 位。`);
  }

  if (!found) lines.push('暂无荣誉数据（群荣誉可能未开启，或该群暂无上榜成员）。');
  return lines.join('\n');
}

// ── @全体剩余 ─────────────────────────────────────────────────────────────

/**
 * @全体成员剩余次数。data 形状：
 * {can_at_all, remain_at_all_count_for_group, remain_at_all_count_for_uin}
 */
export function formatAtAllRemain(groupId, data) {
  const gid = String(groupId ?? '').trim() || '未知';
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  const rawCan = src.can_at_all ?? src.canAtAll;
  let can = '未知';
  if (rawCan === true || Number(rawCan) === 1) can = '是';
  else if (rawCan === false || Number(rawCan) === 0) can = '否';

  const groupRemain = pickCount(
    src.remain_at_all_count_for_group,
    src.remainAtAllCountForGroup
  ) || '未知';
  const uinRemain = pickCount(
    src.remain_at_all_count_for_uin,
    src.remainAtAllCountForUin
  ) || '未知';

  return [
    `【@全体剩余】群 ${gid}`,
    `可@全体：${can}`,
    `群剩余次数：${groupRemain}`,
    `我的剩余次数：${uinRemain}`
  ].join('\n');
}

// ── 标记已读 ──────────────────────────────────────────────────────────────

/** 标记已读结果：latestId 可能是负数或字符串，原样展示，不做数值转换。 */
export function formatMarkReadResult({
  kind = 'private',
  targetId = 0,
  latestId = null,
  unread = 0,
  ok = true,
  error = ''
} = {}) {
  if (!ok) {
    const reason = String(error ?? '').trim() || '未知错误';
    return `标记已读失败：${reason}`;
  }

  const label = kind === 'group' ? '群' : '私聊';
  const parts = ['已标记已读', `${label} ${pickId(targetId)}`];
  if (latestId !== null && latestId !== undefined && latestId !== '') parts.push(`最新消息 #${latestId}`);
  const n = Number(unread);
  if (unread !== null && unread !== undefined && unread !== '' && Number.isFinite(n) && n >= 0) {
    parts.push(`本地未读 ${Math.trunc(n)} 条`);
  }
  return parts.join('｜');
}

// ── 转发内容 ──────────────────────────────────────────────────────────────

/**
 * 合并转发摘要：复用 forward.js 的格式化结果（昵称/文本清洗/媒体识别都在那边），
 * 这里只补「北京时间 + 序号 + 截断标记」。
 */
export function formatForwardSummary(data, { maxNodes = 30, maxChars = 120 } = {}) {
  const limitNodes = Math.max(1, Math.min(100, Number(maxNodes) || 30));
  const limitChars = Math.max(1, Math.min(2000, Number(maxChars) || 120));
  const formatted = formatForwardResponse(data, { maxMessages: limitNodes, maxCharsPerMessage: limitChars });
  const total = Number(formatted?.total) || 0;
  if (!total) return '没有读取到转发内容。';

  const rawMessages = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
  const shown = Array.isArray(formatted.messages) ? formatted.messages : [];
  const lines = [`【转发内容】共 ${total} 条`];

  shown.forEach((msg, index) => {
    const atMs = timeToMs(msg.time);
    const clock = Number.isFinite(atMs) ? beijingParts(atMs).clock : '未知';
    const source = rawMessages[index];
    const fullText = source ? nodeText(source) : String(msg.text ?? '');
    // formatForwardResponse 只按字符数切，不告诉你「是不是切过」；用原文长度对比才准。
    const cut = fullText.length > limitChars;
    const text = collapse(msg.text) || '（无文本）';
    const name = String(msg.sender ?? '').trim() || '未知';
    const who = msg.userId ? `${name}(${msg.userId})` : name;
    lines.push(`${msg.index ?? index + 1}. ${clock} ${who}：${text}${cut ? '…' : ''}`);
  });

  if (total > shown.length) lines.push(`只显示前 ${shown.length} 条。`);
  return lines.join('\n');
}
