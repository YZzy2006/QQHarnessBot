// 群聊现场提示：纯函数，无 I/O。
//
// 职责边界：
// - DSH preset（qq-chat-v2）已经有完整的静态群聊规则（@必回、不总结、不主持、
//   多人用 qq_reply 等），这里**不重复规则书**。
// - 这里只补模型每轮最需要、但 preset 给不了的东西：当前群里的现场（谁在说、
//   热不热、最近话头）、这轮是“被叫”还是“自己插话”、开头是否重复、发言预算，
//   以及一条人格锚点和私聊记忆边界。
// - 输出控制在几百字，群聊每次唤醒注入；私聊不注入。

const FIVE_MIN = 5 * 60 * 1000;
const FIFTEEN_MIN = 15 * 60 * 1000;

const DIRECT_REASONS = new Set([
  'atMention', 'nameMention', 'question', 'speaker', 'poke', 'encyclopedia',
  'followup', 'reminder'
]);

function toMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function truncateCodePoints(text, max) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('') + '…';
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\p{Cf}/gu, '')
    .trim();
}

/** 取一条消息的正文（优先 tail/plain，最后 text），压成一行并截断。 */
export function messagePreview(message, max = 40) {
  if (!message || typeof message !== 'object') return '';
  const text = message.tail || message.plain || message.text || '';
  return truncateCodePoints(normalizeText(text), max);
}

/**
 * 同一群名片可能对应多个 userId。返回展示名；重名时追加尾号，避免模型把两个人
 * 当成同一个人。没有 userId 时退化为原名片。
 */
export function speakerLabel(message, allMessages = []) {
  if (!message || typeof message !== 'object') return '?';
  const base = normalizeText(message.sender || message.user_id || message.userId || '?') || '?';
  const userId = message.userId != null ? String(message.userId) : (message.user_id != null ? String(message.user_id) : '');
  if (!userId) return base;
  const sameName = (Array.isArray(allMessages) ? allMessages : [])
    .filter((m) => m && normalizeText(m.sender || '') === base)
    .map((m) => String(m.userId ?? m.user_id ?? ''))
    .filter(Boolean);
  const unique = new Set(sameName);
  if (unique.size <= 1) return base;
  return `${base}（尾号${userId.slice(-4)}）`;
}

/**
 * 最近话头：最近 n 条非自己、在 windowMs 内的消息，返回 [{sender,text,at}]。
 * 只用于“最近话头”一行的短引用，不代替消息快照。
 */
export function threadTail(messages, n = 3, nowMs = Date.now(), windowMs = FIFTEEN_MIN) {
  const list = Array.isArray(messages) ? messages : [];
  const now = toMs(nowMs) || Date.now();
  const recent = list.filter((m) => {
    if (!m || m.isSelf) return false;
    const at = toMs(m.time);
    return !at || now - at <= windowMs;
  });
  return recent.slice(-n).map((m) => ({
    sender: speakerLabel(m, list),
    text: messagePreview(m, 40),
    at: toMs(m.time)
  })).filter((item) => item.text);
}

/**
 * 检测自己最近几条消息的开头是否重复。返回重复的前缀（2-4 个字），没有则 null。
 * 这是“像一个群友”而不是“像复读机”的最便宜护栏。
 */
export function repeatOpenerWarning(selfMessages, n = 4, minPrefix = 2) {
  const list = (Array.isArray(selfMessages) ? selfMessages : [])
    .filter((m) => m && (m.isSelf || m.isSelf === true))
    .slice(-n);
  const prefixes = [];
  for (const msg of list) {
    const text = normalizeText(msg.tail || msg.plain || msg.text || '');
    if (!text) continue;
    const prefix = Array.from(text).slice(0, 4).join('');
    if (Array.from(prefix).length >= minPrefix) prefixes.push(prefix);
  }
  if (prefixes.length < 2) return null;
  const counts = new Map();
  for (const prefix of prefixes) {
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  for (const [prefix, count] of counts) {
    if (count >= 2) return prefix;
  }
  return null;
}

/**
 * 统计“回复轮”数量：把连续、间隔不超过 clusterMs 的自己消息算作一轮。
 * 两条自己的消息之间如果夹了别人，算两轮。用于软唤醒的发言预算。
 */
export function countReplyTurns(messages, now = Date.now(), windowMs = 10 * 60 * 1000, clusterMs = 2 * 60 * 1000) {
  const list = Array.isArray(messages) ? messages : [];
  const nowMs = toMs(now) || Date.now();
  let turns = 0;
  let lastSelfAt = 0;
  let inTurn = false;
  for (const msg of list) {
    if (!msg) continue;
    const at = toMs(msg.time) || nowMs;
    if (nowMs - at > windowMs) continue;
    if (msg.isSelf) {
      const gap = lastSelfAt ? at - lastSelfAt : Infinity;
      if (!inTurn || gap > clusterMs) turns += 1;
      inTurn = true;
      lastSelfAt = at;
    } else {
      inTurn = false;
      lastSelfAt = 0;
    }
  }
  return turns;
}

/**
 * 群聊活跃度地板：preset 推荐“普通消息概率 0.05”，但用户明确要活跃群。
 * 只把 0 < p < min 的值抬到下限；显式 0 保留（表示只靠 @/关键词）。
 * 私聊不适用。
 */
export function applyGroupProbabilityFloor(key, probability, minProbability = 0.15) {
  const p = Math.min(1, Math.max(0, Number(probability) || 0));
  const min = Math.min(1, Math.max(0, Number(minProbability) || 0));
  if (String(key).startsWith('group:') && min > 0 && p > 0 && p < min) return min;
  return p;
}

function hotStats(recentMessages, now) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const recent = list.filter((m) => m && !m.isSelf && (!m.time || now - toMs(m.time) <= FIVE_MIN));
  const senders = new Set(recent.map((m) => String(m.userId ?? m.user_id ?? m.sender ?? '')));
  return { count: recent.length, senders: senders.size };
}

function variantFor(reason, addressed) {
  const r = String(reason || '');
  if (r === 'encyclopedia') return 'serious';
  if (r === 'proactiveCheck' || r === 'mealTime') return 'initiate';
  if (r === 'followup' || r === 'reminder') return 'followup';
  if (r === 'poke') return 'poke';
  if (addressed || DIRECT_REASONS.has(r)) return 'direct';
  return 'soft';
}

function instructionFor(variant, lastSpeaker, addressedSpeaker = '') {
  switch (variant) {
    case 'direct': {
      const who = addressedSpeaker || lastSpeaker;
      return `有人点你：${who && who !== '?' ? `${who} 刚 @/提到你` : '消息指向你'}。先回他，哪怕一句「在呢」；再决定要不要接别人。`;
    }
    case 'initiate':
      return '这是你主动开口，不是接话：起个头就停，别用「有人吗」「大家还在吗」；没人接就放着。';
    case 'serious':
      return '这次是正经问题：先答问题，别接梗、别总结；答完就收，别转成客服腔。';
    case 'followup':
      return '到点该自然提一句之前约定的事：像刚想起来，别像闹钟；提完就收。';
    case 'poke':
      return '有人拍了你/拍了别人：想回就回一句或回拍；别频繁。';
    default:
      return '没人点你。接最后一句，像随手插一句；别总结全场、别挨个回、别主持。';
  }
}

function exampleFor(variant) {
  switch (variant) {
    case 'direct':
      return '✅「在呢，咋了」  ❌「您好，请问有什么可以帮您」';
    case 'initiate':
      return '✅「今天风大得我头发都白梳了」  ❌「有人吗」';
    case 'serious':
      return '✅「这个我知道，结论先说：…」  ❌「哈哈哈这个梗我懂」';
    case 'followup':
      return '✅「对了，你昨天说的那个后来咋样了」  ❌「提醒您：您昨日约定的任务尚未完成」';
    default:
      return '✅「B 说的那个我也碰到过」  ❌「看到大家在聊这个，我觉得很有趣」';
  }
}

/**
 * 构建群聊现场块。
 *
 * @param {object} input
 * @param {string} input.reason 唤醒原因（evaluateWakeTriggerV2 的返回值）
 * @param {number} [input.now]
 * @param {Array} [input.recentMessages] 本群 recentMessages（含 isSelf）
 * @param {number} [input.unreadCount]
 * @param {boolean} [input.addressed] 是否被 @/点名/引用；不传时按 reason 推断
 * @param {number} [input.lastAiReplyAt]
 * @param {string} [input.mode] active/diving
 * @param {number} [input.maxChars]
 * @param {boolean} [input.enabled]
 * @returns {string} 空串表示不注入
 */
export function buildGroupChatBlockV2(input = {}) {
  if (input.enabled === false) return '';
  const now = toMs(input.now) || Date.now();
  const messages = Array.isArray(input.recentMessages) ? input.recentMessages : [];
  const reason = String(input.reason || '');
  const addressed = input.addressed === true || DIRECT_REASONS.has(reason);
  const variant = variantFor(reason, addressed);
  const hot = hotStats(messages, now);
  const tail = threadTail(messages, 3, now);
  const lastSpeaker = tail.length ? tail[tail.length - 1].sender : '?';
  const addressedSpeaker = String(input.addressedSpeaker || '').trim();
  const unreadCount = Math.max(0, Number(input.unreadCount) || 0);
  const lastAiReplyAt = toMs(input.lastAiReplyAt);
  const repeat = repeatOpenerWarning(messages.filter((m) => m && m.isSelf));
  const maxChars = Math.max(200, Math.min(1600, Number(input.maxChars) || 900));

  const lines = ['【群聊现场｜这是群，不是私聊】'];
  const situation = [`未读 ${unreadCount} 条`];
  if (hot.count > 0) situation.push(`近5分钟 ${hot.count} 条/${hot.senders} 人`);
  if (lastSpeaker !== '?') situation.push(`最后说话：${lastSpeaker}`);
  lines.push(situation.join('；'));

  if (tail.length) {
    lines.push(`最近话头：${tail.map((item) => `${item.sender}「${item.text}」`).join(' → ')}`);
  }
  lines.push(instructionFor(variant, lastSpeaker, addressedSpeaker));
  lines.push(exampleFor(variant));
  lines.push('一轮最多发 2-3 条；已经发满 3 条就别马上补第 4 条，先等对方回或下一轮。');

  if (lastAiReplyAt && now - lastAiReplyAt < 120000) {
    lines.push(`你 ${Math.max(1, Math.round((now - lastAiReplyAt) / 60000))} 分钟前刚说过话；这轮挑一句就够，别硬补。`);
  }
  if (repeat) {
    lines.push(`你最近的开头有点重复（「${repeat}」），换一种。`);
  }
  if (input.budget && input.budget.nearLimit) {
    lines.push('快到本小时的发言预算了；只接真正想接的一句。');
  }

  const personaName = String(input.personaName || '').trim();
  lines.push(`${personaName ? `你是${personaName}，` : '你是这个角色，'}一个活人，不是 AI/客服；被问是不是机器人 → 笑着岔开，不解释、不承认。`);
  lines.push('群聊只聊本群的事；私聊内容、QQ号/群号/路径、别人的隐私一个字都不带进来。');

  const block = lines.join('\n');
  return block.length > maxChars ? truncateCodePoints(block, maxChars) : block;
}
