// 指令参数分段：纯字符串工具，不做 I/O。
//
// 支持两种写法：
//   1. 每个参数一个方括号：[定时任务][明天早上][示例好友甲][给我说早安]
//   2. 传统写法：定时任务 明天早上 示例好友甲 给我说早安
//
// 只有「整条消息由多个方括号段组成」时才返回段数组；单段仍交给原有
// 解析器按空格切分，避免把 `[私聊白名单 添加 123]` 误拆成命令 + 参数。

/**
 * 把整条消息拆成方括号段；不是「多段方括号」写法时返回 null。
 * 段内空格原样保留（群名/好友名/内容里可以有空格）。
 * @returns {string[]|null}
 */
export function bracketSegments(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;

  const segments = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;

    const open = s[i];
    if (open !== '[' && open !== '【') return null;
    const close = open === '[' ? ']' : '】';
    const end = s.indexOf(close, i + 1);
    if (end < 0) return null;

    const body = s.slice(i + 1, end).trim();
    if (!body) return null;
    segments.push(body);
    i = end + 1;
  }

  // 至少两段才进入分段模式；单段等价于普通写法。
  return segments.length >= 2 ? segments : null;
}

/** 去掉一层方括号/书名号式包裹，用于命令名归一化。 */
export function stripOuterBrackets(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^[\[【]([^\]】]*)[\]】]$/);
  return m ? m[1].trim() : s;
}
