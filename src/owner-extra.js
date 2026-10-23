// owner 扩展指令：纯解析/格式化，不做任何 I/O。
//
// 指令：
//   [备份状态] / [群成员查 <群号> <关键词>] / [拍一拍 <QQ>|<群号> <QQ>] /
//   [清上下文 <号码> 确认] / [撤回最近 确认] / [我的名片赞] /
//   [记忆列表] / [忘记记忆 <关键词> 确认] / [收藏列表] / [改昵称 <昵称> 确认] / [高级帮助]
//
// 三条约束：
// 1. 解析只做字符串归一化；取数据、发消息、写文件都在 bridge 里，这里只把「文本 + 数据」变成「文本」。
// 2. 数字（QQ/群号）必须 5~12 位，否则当关键词处理，避免把「12345」这类群名误认成号码。
// 3. 字段缺失一律降级成「未知/缺失」，绝不抛异常：这些函数跑在 QQ 消息路径上，
//    抛错会变成一条「处理失败」的回复，比缺字段更糟。
import { beijingParts } from './model-prices.js';
import { bracketSegments } from './command-args.js';

/** 扩展指令的用法。 */
export const EXTRA_HELP = [
  '【高级帮助】',
  '  [备份状态]                       最近一次备份的时间、大小与校验',
  '  [群成员查 7000001 关键词]      按 QQ/名片/昵称/头衔搜索群成员',
  '  [拍一拍 10001]                   私聊拍一拍；[拍一拍 7000001 10001] 群里拍',
  '  [清上下文 10001 确认]            清空私聊/群的上下文（记忆保留）',
  '  [撤回最近 确认]                  撤回机器人最近一条消息',
  '  [我的名片赞]                     今日与累计名片赞',
  '  [记忆列表]                       长期记忆的会话概览',
  '  [忘记记忆 关键词 确认]           按关键词删除记忆',
  '  [收藏列表 关键词]                表情库（关键词可省略）',
  '  [改昵称 新昵称 确认]             修改机器人昵称',
  '  [消息表情回应 消息id 表情id]      给消息添加 QQ 表情回应',
  '  [取消表情回应 消息id 表情id]      取消表情回应',
  '  [主动唤醒 群号/群名/QQ号/好友名] 立刻触发一次主动唤醒',
  '  [主动对话 目标 内容]             让机器人主动找目标说/做一件事',
  '  [主动状态 目标]                  查看主动问候开关/上次对方发言',
  '  [主动开关 目标 on|off]           单独开关主动问候；[关闭主动 目标] 简写',
  '    超过 3 天没收到对方消息会自动暂停主动问候。',
  '  [限额调整]                       查看私聊/群聊发送限额',
  '  [限额调整 私聊 每分钟 20]        调整限额（群聊同理；0=不限）',
  '  [限额重置 目标]                  重置目标今天的发送计数',
  '  [定时任务 时间 目标 内容]        到点让机器人主动执行',
  '  [定时任务 每天8点 目标 内容 连续7天]  重复任务，可加共N次/到日期/永久',
  '  [定时任务 查看所有]              查看下次执行时间与剩余次数',
  '  [定时任务 取消 序号或id]         取消任务；[取消 全部 确认] 清空',
  '  [查询模型余额 模型名]            查 DeepSeek / 千问 / 豆包 / 小米余额',
  '  [高级帮助]                       本页',
  '',
  '写法：',
  '  • 方括号可省略，全角【】与半角 [] 都认；冒号可以代替空格。',
  '  • QQ 号/群号写 5~12 位数字，其它长度按关键词处理。',
  '  • 目标名里有空格时用分段写法：[主动对话][测试群聊][说句话]。',
  '  • 清上下文 / 撤回 / 忘记记忆 / 改昵称 必须带「确认」才会执行。',
  '',
  '发 [指令] 查看全部指令。'
].join('\n');

// ── 解析 ──────────────────────────────────────────────────────────────────

/** 指令归一化：去掉【】[]、把冒号当分隔符、压缩空白。保留空格，关键词才能带空格。 */
function normalizeCommand(text) {
  return String(text ?? '')
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ID_RE = /^\d{5,12}$/;

/** 去掉「群」「群号」「QQ」这类口头前缀，号码本身才是参数。 */
const NOISE_RE = /^(?:qq|群|群聊|群号|私聊|好友|用户)$/i;

/** 去掉命令末尾的“确认”，返回 { text, confirmed }。 */
function splitConfirm(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/(?:^|\s)(确认[!！]?)\s*$/);
  if (!m) return { text: s, confirmed: false };
  return { text: s.slice(0, m.index).trim(), confirmed: true };
}

function tokensOf(rest) {
  return String(rest ?? '')
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 取第一个 5~12 位数字，没有则 0。 */
function firstId(tokens) {
  for (const token of tokens) {
    if (ID_RE.test(token)) return Number(token);
  }
  return 0;
}

/** 命中前缀则返回剩余文本（可能是空串），不命中返回 null。 */
function matchPrefix(text, keywords) {
  for (const key of keywords) {
    if (text === key) return '';
    if (text.startsWith(key)) return text.slice(key.length).trim();
  }
  return null;
}

const SIMPLE_RULES = [
  [/^(?:备份状态|备份检查|备份)$/, 'backupStatus'],
  [/^(?:我的名片赞|名片赞|获赞)$/, 'profileLikes'],
  [/^(?:记忆列表|查看记忆|记忆概览)$/, 'memoryList'],
  [/^(?:高级帮助|更多帮助|扩展帮助)$/, 'help']
];

// 长的关键字排在前面：否则「备份」会吃掉「备份检查」（这里已用精确匹配兜住，
// 但「撤回最近」与「撤回最近一条」这类仍需长优先）。
const PREFIX_RULES = [
  { keywords: ['群成员搜索', '群成员查', '查群成员'], action: 'memberSearch' },
  { keywords: ['撤回最后一条', '撤回上一条', '撤回最近'], action: 'recallLast' },
  { keywords: ['清除上下文', '清理上下文', '清上下文'], action: 'clearContext' },
  { keywords: ['收藏列表', '收藏表情', '表情库'], action: 'stickerList' },
  { keywords: ['忘记记忆', '删除记忆'], action: 'forgetMemory' },
  { keywords: ['修改昵称', '改昵称'], action: 'setNickname' },
  { keywords: ['拍一拍', '戳一戳'], action: 'poke' }
].sort((a, b) => Math.max(...b.keywords.map((k) => k.length)) - Math.max(...a.keywords.map((k) => k.length)));

/**
 * 解析 owner 扩展指令。
 * @returns {{ok:false}|{ok:true, action:string, groupId?:number, targetId?:number, userId?:number,
 *   query?:string, keyword?:string, nickname?:string, confirmed?:boolean}}
 */
export function parseOwnerExtraCommand(text) {
  // 分段写法：目标名里可以有空格。
  const segments = bracketSegments(text);
  if (segments) {
    const head = String(segments[0] ?? '').replace(/[：:]$/, '').replace(/\s+/g, '');
    const args = segments.slice(1);
    if (['群成员搜索', '群成员查', '查群成员'].includes(head)) {
      const first = String(args[0] ?? '').trim();
      const query = args.slice(1).join(' ').trim();
      if (!first) return { ok: true, action: 'memberSearch', groupId: 0, query };
      return ID_RE.test(first)
        ? { ok: true, action: 'memberSearch', groupId: Number(first), query }
        : { ok: true, action: 'memberSearch', groupId: 0, groupText: first, query };
    }
    if (['拍一拍', '戳一戳'].includes(head)) {
      const a = String(args[0] ?? '').trim();
      const b = String(args[1] ?? '').trim();
      if (!a) return { ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0 };
      if (b) {
        return ID_RE.test(a) && ID_RE.test(b)
          ? { ok: true, action: 'poke', groupId: Number(a), targetId: Number(b), userId: Number(b) }
          : { ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0, groupText: a, userText: b };
      }
      return ID_RE.test(a)
        ? { ok: true, action: 'poke', groupId: 0, targetId: Number(a), userId: Number(a) }
        : { ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0, userText: a };
    }
    if (['清除上下文', '清理上下文', '清上下文'].includes(head)) {
      const split = splitConfirm(args.join(' '));
      const target = split.text.trim();
      return {
        ok: true,
        action: 'clearContext',
        ...(ID_RE.test(target) ? { targetId: Number(target) } : { targetId: 0, targetText: target }),
        confirmed: split.confirmed
      };
    }
  }

  const s = normalizeCommand(text);
  if (!s) return { ok: false };

  for (const [re, action] of SIMPLE_RULES) {
    if (re.test(s)) return { ok: true, action };
  }

  for (const rule of PREFIX_RULES) {
    const rest = matchPrefix(s, rule.keywords);
    if (rest === null) continue;

    if (rule.action === 'memberSearch') {
      const tokens = tokensOf(rest).filter((t) => !NOISE_RE.test(t));
      if (tokens.length && ID_RE.test(tokens[0])) {
        return { ok: true, action: 'memberSearch', groupId: Number(tokens[0]), query: tokens.slice(1).join(' ') };
      }
      // 两个以上词：第一段当群名，其余当关键词（群号位置也支持群名）。
      if (tokens.length >= 2 && !/^\d+$/.test(tokens[0])) {
        return { ok: true, action: 'memberSearch', groupId: 0, groupText: tokens[0], query: tokens.slice(1).join(' ') };
      }
      return { ok: true, action: 'memberSearch', groupId: 0, query: tokens.join(' ') };
    }

    if (rule.action === 'poke') {
      const tokens = tokensOf(rest).filter((t) => !NOISE_RE.test(t));
      const ids = tokens.filter((t) => ID_RE.test(t)).map(Number);
      // 一个号码是私聊，两个号码是「群号 + QQ」。
      if (ids.length >= 2) return { ok: true, action: 'poke', groupId: ids[0], targetId: ids[1], userId: ids[1] };
      if (ids.length === 1) return { ok: true, action: 'poke', groupId: 0, targetId: ids[0], userId: ids[0] };
      // 名字：两个非数字段 = 群名 + 好友名；一个 = 好友名。
      const names = tokens.filter((t) => !/^\d+$/.test(t));
      if (names.length >= 2) {
        return { ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0, groupText: names[0], userText: names[1] };
      }
      if (names.length === 1) {
        return { ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0, userText: names[0] };
      }
      return { ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0 };
    }

    if (rule.action === 'clearContext') {
      const split = splitConfirm(rest);
      const tokens = tokensOf(split.text).filter((t) => !NOISE_RE.test(t));
      const first = tokens[0] ?? '';
      if (first && !ID_RE.test(first) && !/^\d+$/.test(first)) {
        return { ok: true, action: 'clearContext', targetId: 0, targetText: tokens.join(' '), confirmed: split.confirmed };
      }
      return { ok: true, action: 'clearContext', targetId: firstId(tokens), confirmed: split.confirmed };
    }

    if (rule.action === 'recallLast') {
      const split = splitConfirm(rest);
      const out = { ok: true, action: 'recallLast' };
      if (split.confirmed) out.confirmed = true;
      return out;
    }

    if (rule.action === 'forgetMemory') {
      const split = splitConfirm(rest);
      const out = { ok: true, action: 'forgetMemory', keyword: split.text };
      if (split.confirmed) out.confirmed = true;
      return out;
    }

    if (rule.action === 'setNickname') {
      const split = splitConfirm(rest);
      const out = { ok: true, action: 'setNickname', nickname: split.text };
      if (split.confirmed) out.confirmed = true;
      return out;
    }

    if (rule.action === 'stickerList') {
      return { ok: true, action: 'stickerList', keyword: rest };
    }
  }

  return { ok: false };
}

// ── 通用小工具 ────────────────────────────────────────────────────────────

/** 秒级/毫秒级时间戳都接受；非法值返回 NaN。 */
function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n < 1e11 ? n * 1000 : n;
}

/** 北京时间的 YYYY-MM-DD HH:mm（不依赖运行机器的时区）。 */
function bjDateTime(ms) {
  const p = beijingParts(ms);
  return `${p.date} ${p.clock}`;
}

/** 北京时间的 YYYY-MM-DD。 */
function bjDate(ms) {
  return beijingParts(ms).date;
}

/** 北京时间的 MM-DD HH:mm。 */
function bjShort(ms) {
  return `${beijingParts(ms).date.slice(5)} ${beijingParts(ms).clock}`;
}

/** 「X天前」/「X小时Y分前」/「X分前」/「刚刚」。 */
function agoText(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 60000) return '刚刚';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  if (days >= 1) return `${days}天前`;
  const hours = Math.floor(mins / 60);
  if (hours >= 1) return `${hours}小时${mins % 60}分前`;
  return `${mins}分前`;
}

/** 把空白（含换行）压成单个空格：记忆/昵称一律单行展示。 */
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

/** 计数：非法/负数一律按 0，避免输出 NaN。 */
function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function capOf(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

/** 群号/QQ：缺省显示「未知」。 */
function idText(value) {
  const s = String(value ?? '').trim();
  return s && s !== '0' ? s : '未知';
}

// ── 备份状态 ──────────────────────────────────────────────────────────────

/**
 * 备份状态：服务器与异地各一行，超阈值打 ⚠️。
 * server: {path,at,size,sha256}；offsite: {at}。at 支持秒或毫秒时间戳。
 */
export function formatBackupStatus({ server = {}, offsite = {}, now = Date.now(), thresholdHours = 36 } = {}) {
  const srv = server && typeof server === 'object' ? server : {};
  const off = offsite && typeof offsite === 'object' ? offsite : {};
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const threshold = Number(thresholdHours) > 0 ? Number(thresholdHours) : 36;

  let stale = false;
  let missing = false;

  const rowOf = (label, at, extra, withHeartbeat) => {
    const ms = toMs(at);
    if (!Number.isFinite(ms)) {
      missing = true;
      return `${label}：缺失${withHeartbeat ? ' · 心跳缺失' : ''} ⚠️`;
    }
    const age = nowMs - ms;
    const over = age > threshold * 3600000;
    if (over) stale = true;
    const parts = [bjDateTime(ms), agoText(age), ...extra, ...(withHeartbeat ? ['心跳正常'] : [])].filter(Boolean);
    return `${label}：${parts.join(' · ')}${over ? ' ⚠️' : ''}`;
  };

  const sizeBytes = Number(srv.size);
  const sizeText = Number.isFinite(sizeBytes) && sizeBytes > 0
    ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : '大小缺失';
  const shaText = String(srv.sha256 ?? '').trim() ? 'sha256 ✓' : 'sha256 缺失';

  // 必须先把两行都算出来（rowOf 会置 missing/stale），再下结论。
  const serverRow = rowOf('服务器', srv.at, [sizeText, shaText], false);
  const offsiteRow = rowOf('异地', off.at, [], true);
  const verdict = stale
    ? `超过 ${threshold} 小时，请检查`
    : (missing ? '备份缺失，请检查' : '正常');

  return [
    '【备份状态】',
    serverRow,
    offsiteRow,
    `结论：${verdict}`
  ].join('\n');
}

// ── 群成员查 ──────────────────────────────────────────────────────────────

const ROLE_LABELS = { owner: '群主', admin: '管理员', member: '成员' };

function roleLabel(role) {
  const key = String(role ?? '').trim().toLowerCase();
  return ROLE_LABELS[key] ?? '成员';
}

/** 纯数字按 QQ 号包含匹配；否则匹配名片/昵称/头衔（不区分大小写）。 */
function memberMatches(member, keyword, lower) {
  if (/^\d+$/.test(keyword)) return String(member.user_id ?? '').includes(keyword);
  return [member.card, member.nickname, member.title]
    .some((field) => String(field ?? '').toLowerCase().includes(lower));
}

/**
 * 群成员搜索结果。
 * members: [{user_id,nickname,card,role,title,join_time,last_sent_time,shut_up_timestamp}]
 */
export function formatMemberSearch({ groupId = 0, members = [], query = '', now = Date.now(), limit = 30 } = {}) {
  void now; // 保留参数位：与其它格式化函数统一签名，判定只用时间戳本身
  const cap = capOf(limit, 30, 200);
  const list = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === 'object');
  const keyword = collapse(query);
  const lower = keyword.toLowerCase();
  const matched = keyword ? list.filter((m) => memberMatches(m, keyword, lower)) : list;

  const lines = [`【群成员查】群 ${idText(groupId)}｜关键词「${keyword || '（全部）'}」｜${matched.length} 人`];
  if (!matched.length) {
    lines.push('没找到匹配的成员。');
    return lines.join('\n');
  }

  const shown = matched.slice(0, cap);
  shown.forEach((member, index) => {
    const uid = String(member.user_id ?? '').trim();
    const name = pickText(member.card, member.nickname);
    const who = name ? (uid ? `${name}(${uid})` : name) : (uid ? `QQ ${uid}` : '未知');
    const parts = [who, roleLabel(member.role)];

    const title = pickText(member.title);
    if (title) parts.push(title);

    const joinMs = toMs(member.join_time);
    parts.push(`入群 ${Number.isFinite(joinMs) ? bjDate(joinMs) : '未知'}`);

    const lastMs = toMs(member.last_sent_time);
    parts.push(`最后发言 ${Number.isFinite(lastMs) ? bjShort(lastMs) : '未知'}`);

    lines.push(`${index + 1}. ${parts.join('｜')}`);
  });

  if (matched.length > shown.length) lines.push(`只显示前 ${shown.length} 人。`);
  return lines.join('\n');
}

// ── 我的名片赞 ────────────────────────────────────────────────────────────

/**
 * 名片赞：按次数降序展示可见的点赞用户。
 * data.favoriteInfo={total_count,today_count,userInfos:[{uin,count,latestTime,nick}]}，voteInfo 可选。
 */
export function formatProfileLikes({ data = {}, labels = {}, now = Date.now(), limit = 10 } = {}) {
  void now;
  const src = data && typeof data === 'object' ? data : {};
  const fav = src.favoriteInfo && typeof src.favoriteInfo === 'object' ? src.favoriteInfo : {};
  const dir = labels && typeof labels === 'object' ? labels : {};
  const users = (Array.isArray(fav.userInfos) ? fav.userInfos : []).filter((u) => u && typeof u === 'object');
  const cap = capOf(limit, 10, 100);

  // 有些版本 total_count 恒为 0，但 userInfos 的 count 之和是真实可见累计。
  const visibleTotal = countOf(fav.total_count)
    || users.reduce((sum, user) => sum + countOf(user.count), 0);
  const lines = [`【我的名片赞】今日 ${countOf(fav.today_count)} 次｜可见累计 ${visibleTotal} 次｜点赞用户 ${users.length} 位`];

  const vote = src.voteInfo && typeof src.voteInfo === 'object' ? src.voteInfo : null;
  if (vote) {
    const todayVotes = countOf(vote.today_count ?? vote.todayCount);
    const totalVotes = countOf(vote.total_count ?? vote.totalCount);
    if (todayVotes || totalVotes) lines.push(`投票：今日 ${todayVotes} 次｜累计 ${totalVotes} 次`);
  }

  if (!users.length) {
    lines.push('暂时看不到点赞用户（接口没有返回名单）。');
    return lines.join('\n');
  }

  const sorted = [...users].sort((a, b) => countOf(b.count) - countOf(a.count)
    || (toMs(b.latestTime) || 0) - (toMs(a.latestTime) || 0));
  const shown = sorted.slice(0, cap);

  shown.forEach((user, index) => {
    const uin = String(user.uin ?? '').trim();
    const nick = pickText(dir[uin], user.nick, user.nickname);
    const who = nick ? (uin ? `${nick}(${uin})` : nick) : (uin ? `QQ ${uin}` : '未知');
    const latestMs = toMs(user.latestTime);
    lines.push(`${index + 1}. ${who}｜${countOf(user.count)} 次｜最近 ${Number.isFinite(latestMs) ? bjShort(latestMs) : '未知'}`);
  });

  if (sorted.length > shown.length) lines.push(`只显示前 ${shown.length} 位。`);
  return lines.join('\n');
}

// ── 记忆列表 ──────────────────────────────────────────────────────────────

/** 印象：{label:{traits,interactionCount,lastSeenAt}}，只取第一条。 */
function firstImpression(impressions) {
  if (!impressions || typeof impressions !== 'object') return '';
  for (const [label, value] of Object.entries(impressions)) {
    const item = value && typeof value === 'object' ? value : {};
    const traits = Array.isArray(item.traits)
      ? item.traits.map((t) => collapse(t)).filter(Boolean)
      : [];
    const times = countOf(item.interactionCount);
    const head = `${collapse(label) || '未命名'}${times ? `（${times} 次）` : ''}`;
    return traits.length ? `${head}：${traits.join('、')}` : head;
  }
  return '';
}

function firstText(items) {
  if (!Array.isArray(items)) return '';
  for (const item of items) {
    const text = collapse(typeof item === 'string' ? item : item?.text);
    if (text) return text;
  }
  return '';
}

/**
 * 记忆列表：每个会话最多一条印象/话题/想法，正文截断 60 字。
 * conversations: [{key, impressions, topics:[{text}], thoughts:[{text}]}]
 */
export function formatMemoryList({ conversations = [], vectorCount = 0, now = Date.now(), limit = 8 } = {}) {
  void now;
  const list = (Array.isArray(conversations) ? conversations : []).filter((c) => c && typeof c === 'object');
  const cap = capOf(limit, 8, 50);
  const lines = [`【记忆列表】${list.length} 个会话｜向量 ${countOf(vectorCount)} 条`];

  if (!list.length) {
    lines.push('暂无记忆。');
    return lines.join('\n');
  }

  const shown = list.slice(0, cap);
  shown.forEach((conv, index) => {
    lines.push(`${index + 1}. ${collapse(conv.key) || '未知会话'}`);

    const impression = truncateText(firstImpression(conv.impressions), 60);
    if (impression.text) lines.push(`   印象：${impression.text}${impression.truncated ? '…' : ''}`);

    const topic = truncateText(firstText(conv.topics), 60);
    if (topic.text) lines.push(`   话题：${topic.text}${topic.truncated ? '…' : ''}`);

    const thought = truncateText(firstText(conv.thoughts), 60);
    if (thought.text) lines.push(`   想法：${thought.text}${thought.truncated ? '…' : ''}`);
  });

  if (list.length > shown.length) lines.push(`只显示前 ${shown.length} 个会话。`);
  return lines.join('\n');
}

// ── 忘记记忆（匹配结果） ──────────────────────────────────────────────────

/** matches: [{key,kind,text}]，kind 为 印象/话题/想法。 */
export function formatMemoryMatches({ keyword = '', matches = [], limit = 20 } = {}) {
  const list = (Array.isArray(matches) ? matches : []).filter((m) => m && typeof m === 'object');
  const cap = capOf(limit, 20, 200);
  const lines = [`【忘记记忆】关键词「${collapse(keyword)}」｜匹配 ${list.length} 条`];

  if (!list.length) {
    lines.push('没有匹配到记忆。');
    return lines.join('\n');
  }

  const shown = list.slice(0, cap);
  shown.forEach((match, index) => {
    const body = truncateText(collapse(match.text), 80);
    const key = collapse(match.key) || '未知会话';
    const kind = collapse(match.kind) || '记忆';
    lines.push(`${index + 1}. ${key}｜${kind}｜${body.text}${body.truncated ? '…' : ''}`);
  });

  if (list.length > shown.length) lines.push(`只显示前 ${shown.length} 条。`);
  return lines.join('\n');
}

// ── 动作结果 ──────────────────────────────────────────────────────────────

export function formatPokeResult({ groupId = 0, targetId = 0, ok = true, error = '' } = {}) {
  if (!ok) return `拍一拍失败：${collapse(error) || '未知错误'}`;
  const qq = idText(targetId);
  return Number(groupId) > 0
    ? `已拍一拍群 ${idText(groupId)} 里的 QQ ${qq}`
    : `已拍一拍 QQ ${qq}`;
}

export function formatClearContextResult({ kind = 'private', targetId = 0, ok = true, error = '' } = {}) {
  if (!ok) return `清上下文失败：${collapse(error) || '未知错误'}`;
  const label = kind === 'group' ? '群' : '私聊';
  return `已清空 ${label} ${idText(targetId)} 的上下文（记忆保留）`;
}

export function formatRecallResult({ ok = true, messageId = null, preview = '', error = '' } = {}) {
  if (!ok) return `撤回最近失败：${collapse(error) || '未知错误'}`;
  const id = messageId === null || messageId === undefined || messageId === '' ? '' : ` #${messageId}`;
  const text = truncateText(collapse(preview), 60).text;
  return `已撤回最近一条消息${id}${text ? `：${text}` : ''}`;
}

export function formatNicknameResult({ ok = true, nickname = '', error = '' } = {}) {
  if (!ok) return `改昵称失败：${collapse(error) || '未知错误'}`;
  return `已把昵称改为「${collapse(nickname) || '未知'}」`;
}

// ── 收藏表情 ──────────────────────────────────────────────────────────────

/**
 * 收藏摘要：result 来自 sticker-lib.formatStickerList。
 * {total,matched,truncated,stickers:[{id,desc,localNote,tags,usage,useCount}]}
 */
export function formatStickerSummary(result = {}, { query = '' } = {}) {
  const src = result && typeof result === 'object' ? result : {};
  const stickers = (Array.isArray(src.stickers) ? src.stickers : []).filter((s) => s && typeof s === 'object');
  const keyword = collapse(query);
  const head = `【收藏表情】共 ${countOf(src.total)} 个｜匹配 ${countOf(src.matched)} 个${keyword ? `｜关键词「${keyword}」` : ''}`;
  const lines = [head];

  if (!stickers.length) {
    lines.push(keyword ? '没有匹配到表情。' : '收藏里还没有表情。');
    return lines.join('\n');
  }

  const cap = 20;
  const shown = stickers.slice(0, cap);
  shown.forEach((sticker, index) => {
    const label = pickText(sticker.desc, sticker.localNote) || '无备注';
    const tags = Array.isArray(sticker.tags)
      ? sticker.tags.map((t) => collapse(t)).filter(Boolean)
      : (typeof sticker.tags === 'string' ? sticker.tags.split(/[,，/、]/).map((t) => t.trim()).filter(Boolean) : []);
    const used = countOf(sticker.useCount);
    const id = String(sticker.id ?? '').trim();
    // 收藏 id 往往是很长的资源号；列表里只留末 8 位，避免一条占满屏幕。
    const shortId = id.length > 16 ? `…${id.slice(-8)}` : id;

    const parts = [label];
    if (tags.length) parts.push(`[${tags.join('/')}]`);
    if (used) parts.push(`（用过${used}次）`);
    if (shortId) parts.push(`#${shortId}`);
    lines.push(`${index + 1}. ${parts.join(' ')}`);
  });

  if (stickers.length > shown.length) lines.push(`只显示前 ${shown.length} 条。`);
  return lines.join('\n');
}
