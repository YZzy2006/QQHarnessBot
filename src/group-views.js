// 群聊记录转发指令：纯解析/文案，不做 I/O。
//
// owner 私聊：
//   [查看群聊 123456789 最近 20 条对话]
//   [查看群聊 示例好友甲]
//   [查看群消息 123456789 最近 10 条]
//   [群聊记录 示例好友甲 30]
//
// 群名可能带空格，所以用「最近」当分隔符；群号 5-12 位数字时直接给 groupId。
// 记录用合并转发发到 owner 私聊，不逐条刷屏，也不进聊天记忆。

const DEFAULT_COUNT = 20;
// 和好友查看保持一致：一次最多 100 条，再多服务端会丢消息。
const MAX_COUNT = 100;

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

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

function clampCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_COUNT, Math.round(n)));
}

/** 群号识别：5-12 位纯数字，其余按群名处理。 */
function isGroupId(target) {
  return /^\d{5,12}$/.test(target);
}

function chatResult(targetText, count, raw) {
  const target = String(targetText ?? '').trim();
  if (!target) return { ok: false };
  const n = clampCount(count, DEFAULT_COUNT);
  if (isGroupId(target)) return { ok: true, action: 'chat', groupId: Number(target), count: n, raw };
  return { ok: true, action: 'chat', target, count: n, raw };
}

export const GROUP_VIEW_HELP = [
  '【群聊记录查看 · 用法】',
  '查看某个群的最近聊天（默认 20 条，最多 100 条）：',
  '  [查看群聊 测试群聊 最近 20 条对话]',
  '  [查看群聊 123456789]',
  '  [查看群消息 123456789 最近 10 条]',
  '  [群聊记录 测试群聊 30]',
  '',
  '群号是 5-12 位数字，直接写群号最快；群名可以带空格，用「最近」隔开条数。',
  '说明：记录用合并转发发到 owner 私聊，不逐条刷屏；这些指令不会进机器人的聊天记忆。'
].join('\n');

/** 解析群聊记录转发指令。 */
export function parseGroupViewCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false };
  const s = raw
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { ok: false };
  const compact = s.replace(/\s+/g, '');

  if (/^(?:群聊查看帮助|群聊转发帮助|群聊记录帮助)$/.test(compact)) {
    return { ok: true, help: true, raw };
  }

  // 带条数：[查看群聊 <群号或群名> 最近 <N> 条对话] / [查看群消息 ... 最近 <N> 条]
  let m = s.match(/^(?:查看群聊|查看群消息)\s*(.+?)\s*(?:的)?\s*最近\s*([0-9一二两三四五六七八九十]+)\s*条?\s*(?:对话|聊天|聊天记录|消息|记录)?$/);
  if (m) return chatResult(m[1], parseCountNumber(m[2]), raw);

  // 说了「最近」但没给条数：[查看群聊 示例好友甲 最近对话]
  m = s.match(/^(?:查看群聊|查看群消息)\s*(.+?)\s*(?:的)?\s*最近(?:的)?\s*(?:对话|聊天|聊天记录|消息|记录)?$/);
  if (m) return chatResult(m[1], DEFAULT_COUNT, raw);

  // 只给群：[查看群聊 <群号或群名>]；以「最近」开头的残缺写法交给引导，不猜。
  m = s.match(/^(?:查看群聊|查看群消息)\s*(?!最近)(.+)$/);
  if (m) return chatResult(m[1], DEFAULT_COUNT, raw);

  // 紧凑写法：[群聊记录 <群号或群名> <N>]
  m = s.match(/^群聊记录\s*(.+?)\s+([0-9一二两三四五六七八九十]+)$/);
  if (m) return chatResult(m[1], parseCountNumber(m[2]), raw);

  return { ok: false };
}
