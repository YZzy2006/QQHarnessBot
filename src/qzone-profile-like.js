// 好友资料卡点赞指令解析：纯函数，不做任何 I/O。
//
// owner 私聊里的写法（每段推荐加方括号）：
//   [资料卡点赞] [示例好友甲] [10]
//   [资料卡点赞] [7770486] [5]
//   [资料卡点赞] [1] [10]        // 重名候选按序号选
//   [给示例好友甲的资料卡点赞] [10]
// 解析结果交给 bridge.js 执行；这里只负责“听懂”。

export const PROFILE_LIKE_DEFAULTS = Object.freeze({
  times: 10,
  maxTimes: 10
});

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 支持 3 / 三 / 十 / 十五 / 二十 / 二十五。 */
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

function normalizeText(value) {
  return String(value ?? '')
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const PROFILE_LIKE_HELP = [
  '【好友资料卡点赞 · 用法】',
  '写法：每段都加方括号（推荐），例：[资料卡点赞] [示例好友甲] [10]。',
  '  次数可省略，默认 10；单好友每天最多 10 次，超过按 10 次。',
  '  也可以直接用 QQ 号：[资料卡点赞] [7770486] [10]。',
  '',
  '给好友点赞：',
  '  [资料卡点赞] [示例好友甲] [10]',
  '  [资料卡点赞] [示例好友甲]            （默认 10 次）',
  '  [资料卡点赞] [7770486] [5]',
  '',
  '重名好友：机器人先列出候选，按序号选（10 分钟内有效）：',
  '  [资料卡点赞] [示例好友甲] [10]',
  '  → 找到 2 个「示例好友甲」：',
  '    1. 示例好友甲（QQ 11111111）',
  '    2. 示例好友甲（QQ 22222222，备注：老王）',
  '  [资料卡点赞 1] [10]                （选第 1 个）',
  '  [资料卡点赞 2] [5]                 （选第 2 个，5 次）',
  '',
  '例：',
  '  [资料卡点赞] [示例好友甲] [10]',
  '  [资料卡点赞] [7770486] [5]'
].join('\n');

/**
 * 解析资料卡点赞指令。
 * @returns {{ok:true,help:true,raw:string}
 *   |{ok:true,missingTarget:true,times:number,requested:number,clamped:boolean,raw:string}
 *   |{ok:true,target?:string,index?:number,uin?:number,times:number,requested:number,clamped:boolean,raw:string}
 *   |{ok:false}}
 */
export function parseProfileLikeCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false };
  const normalized = normalizeText(raw);
  if (!normalized) return { ok: false };

  const compact = normalized.replace(/\s+/g, '');
  if (/^(?:资料卡点赞|名片点赞|资料卡赞|名片赞)(?:帮助|用法|说明)?$/.test(compact)) {
    return { ok: true, help: true, raw };
  }

  let rest = '';
  let m = normalized.match(/^(?:资料卡点赞|名片点赞|资料卡赞|名片赞)(?:吧|一下)?\s*(.*)$/);
  if (m) {
    rest = m[1].trim();
  } else {
    // 给[示例好友甲]的资料卡点赞 [10]
    m = normalized.match(/^给\s*(.+?)\s*(?:的)?\s*(?:资料卡|名片)\s*(?:点赞|赞)\s*(.*)$/);
    if (!m) return { ok: false };
    rest = `${m[1].trim()} ${m[2].trim()}`.trim();
  }

  if (!rest) {
    return {
      ok: true, missingTarget: true, times: PROFILE_LIKE_DEFAULTS.times,
      requested: PROFILE_LIKE_DEFAULTS.times, clamped: false, raw
    };
  }

  // 次数：末尾“N次”，或末尾单独的 N（数字/中文数字）。
  let timesRaw = '';
  const suffix = rest.match(/(?:^|\s)([0-9]+|[一二两三四五六七八九十]+)\s*次\s*$/);
  if (suffix) {
    timesRaw = suffix[1];
    rest = rest.slice(0, suffix.index).trim();
  } else {
    const parts = rest.split(/\s+/);
    if (parts.length >= 2 && /^(?:[0-9]+|[一二两三四五六七八九十]+)$/.test(parts[parts.length - 1])) {
      timesRaw = parts.pop();
      rest = parts.join(' ').trim();
    }
  }

  let requested = PROFILE_LIKE_DEFAULTS.times;
  if (timesRaw) {
    const n = parseCountNumber(timesRaw);
    if (Number.isFinite(n)) requested = Math.round(n);
  }
  const times = Math.max(1, Math.min(PROFILE_LIKE_DEFAULTS.maxTimes, requested));
  const clamped = times !== requested;

  const target = rest.trim();
  if (!target) {
    return { ok: true, missingTarget: true, times, requested, clamped, raw };
  }

  const compactTarget = target.replace(/\s+/g, '');
  if (/^\d{1,2}$/.test(compactTarget)) {
    return { ok: true, index: Number(compactTarget), target, times, requested, clamped, raw };
  }
  if (/^\d{5,12}$/.test(compactTarget)) {
    return { ok: true, uin: Number(compactTarget), target, times, requested, clamped, raw };
  }
  return { ok: true, target, times, requested, clamped, raw };
}
