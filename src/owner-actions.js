// owner 主动/限额/定时/表情回应指令：纯解析/格式化，不做 I/O。
//
// 推荐写法（每段一个方括号，参数里可以有空格）：
//   [消息表情回应][message_id][emoji_id]
//   [取消表情回应][message_id][emoji_id]
//   [主动唤醒][群号/群名/QQ号/好友名]
//   [主动对话][目标][要说什么/要做什么]
//   [限额调整] / [限额调整][私聊|群聊][每分钟|每小时|每天][数值]
//   [限额重置][目标]
//   [定时任务][时间][目标][要做什么]
//   [查询模型余额][deepseek|千问|豆包|小米]
//
// 也兼容传统空格写法；目标名里有空格时请用分段写法。
import { bracketSegments } from './command-args.js';
import { cnNumber } from './time-parse.js';

const SCOPE_LABELS = { private: '私聊', group: '群聊' };
const WINDOW_LABELS = { minute: '每分钟', hour: '每小时', day: '每天' };

function normalize(text) {
  return String(text ?? '')
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function commandKey(value) {
  return normalize(value).replace(/\s+/g, '').toLowerCase();
}

function scopeOf(value) {
  const s = commandKey(value);
  if (['私聊', '个人', '好友', 'private', '私'].includes(s)) return 'private';
  if (['群聊', '群', 'group', '群组'].includes(s)) return 'group';
  return '';
}

function windowOf(value) {
  const s = commandKey(value);
  if (['每分钟', '分钟', '每分', '分', 'minute', 'min'].includes(s)) return 'minute';
  if (['每小时', '小时', '每时', '时', 'hour', 'hr'].includes(s)) return 'hour';
  if (['每天', '天', '每日', '日', 'day'].includes(s)) return 'day';
  return '';
}

function enabledOf(value) {
  const s = commandKey(value);
  if (['on', '开', '开启', '启用', 'true', '1'].includes(s)) return true;
  if (['off', '关', '关闭', '停用', 'false', '0'].includes(s)) return false;
  return null;
}

function providerOf(value) {
  const s = commandKey(value);
  if (['deepseek', '深度求索', '深度探索', 'ds', 'd老师'].includes(s)) return 'deepseek';
  if (['千问', '通义', '通义千问', '百炼', 'qwen', 'bailian', 'dashscope'].includes(s)) return 'qwen';
  if (['豆包', '火山', '方舟', '火山方舟', 'doubao', 'volc', 'volcano', 'ark'].includes(s)) return 'doubao';
  if (['小米', 'xiaomi', 'mimo', '小米mimo'].includes(s)) return 'xiaomi';
  return '';
}

/** 「连续7天 / 共10次 / 7次 / 永久」→ 次数条件；不是条件返回 null。 */
function parseCountOption(text) {
  const s = commandKey(text);
  if (!s) return null;
  if (['永久', '长期', '一直'].includes(s)) return { kind: 'forever' };
  const m = s.match(/^(?:连续|共|总共)?([零〇一二三四五六七八九十\d]{1,3})(天|次|周|个月|月)$/);
  if (!m) return null;
  // 只有「N次」或带「连续/共」的才认；单独的「7天」可能是正文，不当条件。
  const hasPrefix = /^(?:连续|共|总共)/.test(s) || m[2] === '次';
  if (!hasPrefix) return null;
  const n = cnNumber(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 500) return null;
  return { kind: 'count', count: n };
}

/** 「到2026-10-28 / 截止10月28日」这类结束条件。 */
function isEndOption(text) {
  return /^(?:到|截止|截至|直到)\s*[零〇一二三四五六七八九十\d]/.test(String(text ?? '').trim());
}

function positiveInt(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || n > 5000) return null;
  return n;
}

/**
 * 解析 owner 主动/限额/定时/表情回应指令。
 * @returns {{ok:false}|{ok:true, action:string, ...}}
 */
export function parseOwnerActionCommand(text) {
  const segments = bracketSegments(text);
  let head;
  let args;
  if (segments) {
    head = segments[0];
    args = segments.slice(1);
  } else {
    const tokens = normalize(text).split(' ').filter(Boolean);
    if (!tokens.length) return { ok: false };
    head = tokens[0];
    args = tokens.slice(1);
  }

  const key = commandKey(head);
  if (!key) return { ok: false };

  // ── 消息表情回应 ──────────────────────────────────────────────────────
  if (['消息表情回应', '表情回应', '回应消息', '表情回应消息'].includes(key)) {
    const messageId = /^-?\d+$/.test(String(args[0] ?? '')) && Number(args[0]) !== 0 ? Number(args[0]) : null;
    const emojiId = String(args[1] ?? '').trim();
    if (messageId === null || !emojiId) {
      return { ok: false, action: 'emojiLike', error: 'invalid-args' };
    }
    return { ok: true, action: 'emojiLike', messageId, emojiId, set: true };
  }
  if (['取消表情回应', '取消回应', '移除表情回应'].includes(key)) {
    const messageId = /^-?\d+$/.test(String(args[0] ?? '')) && Number(args[0]) !== 0 ? Number(args[0]) : null;
    const emojiId = String(args[1] ?? '').trim();
    if (messageId === null || !emojiId) {
      return { ok: false, action: 'emojiLike', error: 'invalid-args' };
    }
    return { ok: true, action: 'emojiLike', messageId, emojiId, set: false };
  }

  // ── 主动唤醒 ──────────────────────────────────────────────────────────
  if (['主动唤醒', '主动换醒', '唤醒', '主动叫醒', '叫醒'].includes(key)) {
    const target = String(args[0] ?? '').trim();
    if (!target) return { ok: false, action: 'wake', error: 'missing-args' };
    return { ok: true, action: 'wake', target };
  }

  // ── 主动对话 ──────────────────────────────────────────────────────────
  if (['主动对话', '主动发言', '主动说', '主动联系'].includes(key)) {
    const target = String(args[0] ?? '').trim();
    const content = args.slice(1).join(' ').trim();
    if (!target || !content) return { ok: false, action: 'talk', error: 'missing-args' };
    if (content.length > 500) return { ok: false, action: 'talk', error: 'content-too-long' };
    return { ok: true, action: 'talk', target, content };
  }

  // ── 主动问候开关（单会话）─────────────────────────────────────────────
  if (['主动开关', '主动问候', '主动状态', '关闭主动', '开启主动'].includes(key)) {
    const target = String(args[0] ?? '').trim();
    if (!target) return { ok: false, action: 'proactiveStatus', error: 'missing-args' };
    if (key === '关闭主动') return { ok: true, action: 'proactiveToggle', target, enabled: false };
    if (key === '开启主动') return { ok: true, action: 'proactiveToggle', target, enabled: true };
    if (key === '主动状态') return { ok: true, action: 'proactiveStatus', target };
    const mode = commandKey(args[1] ?? '');
    if (!mode) return { ok: true, action: 'proactiveStatus', target };
    const enabled = enabledOf(mode);
    if (enabled === null) return { ok: false, action: 'proactiveToggle', error: 'invalid-mode' };
    return { ok: true, action: 'proactiveToggle', target, enabled };
  }

  // ── 限额调整 ──────────────────────────────────────────────────────────
  if (['限额调整', '调整限额', '发送限额', '限额设置'].includes(key)) {
    if (!args.length) return { ok: true, action: 'limitStatus' };
    const scope = scopeOf(args[0]);
    if (!scope) return { ok: false, action: 'limitAdjust', error: 'invalid-scope' };
    if (args.length === 1) return { ok: true, action: 'limitStatus', scope };

    // [限额调整][私聊][20/200/500]：一次设置三档
    const trio = String(args[1] ?? '').match(/^(\d+)\s*[/,，]\s*(\d+)\s*[/,，]\s*(\d+)$/);
    if (trio && args.length === 2) {
      const minute = positiveInt(trio[1]);
      const hour = positiveInt(trio[2]);
      const day = positiveInt(trio[3]);
      if (minute === null || hour === null || day === null) {
        return { ok: false, action: 'limitAdjust', error: 'invalid-value' };
      }
      return { ok: true, action: 'limitAdjustAll', scope, minute, hour, day };
    }

    const window = windowOf(args[1]);
    const value = positiveInt(args[2]);
    if (!window) return { ok: false, action: 'limitAdjust', error: 'invalid-window' };
    if (value === null) return { ok: false, action: 'limitAdjust', error: 'invalid-value' };
    return { ok: true, action: 'limitAdjust', scope, window, value };
  }

  // ── 限额重置 ──────────────────────────────────────────────────────────
  if (['限额重置', '重置限额', '清除限额'].includes(key)) {
    const target = String(args[0] ?? '').trim();
    if (!target) return { ok: false, action: 'limitReset', error: 'missing-args' };
    return { ok: true, action: 'limitReset', target };
  }

  // ── 定时任务 ──────────────────────────────────────────────────────────
  if (['定时任务', '定时发言', '预约任务', '定时对话'].includes(key)) {
    // 「[定时任务][取消 1]」这种方括号里带空格的写法也要能拆出子命令。
    const firstArg = String(args[0] ?? '').trim();
    const firstParts = firstArg.split(/\s+/).filter(Boolean);
    const sub = commandKey(firstParts[0] ?? '');
    const subArgs = [...firstParts.slice(1), ...args.slice(1)]
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);

    if (!args.length || ['查看所有', '查看全部', '全部', '列表', '查看'].includes(sub)) {
      return { ok: true, action: 'scheduleList' };
    }
    if (['帮助', '用法', '怎么用'].includes(sub)) {
      return { ok: true, action: 'scheduleHelp' };
    }
    if (['取消', '删除', '移除'].includes(sub)) {
      let ref = String(subArgs[0] ?? '').trim();
      let confirmed = false;
      if (ref === '确认') { confirmed = true; ref = ''; }
      if (subArgs.length >= 2 && subArgs[subArgs.length - 1] === '确认') confirmed = true;
      if (!ref) return { ok: false, action: 'scheduleCancel', error: 'missing-args' };
      return { ok: true, action: 'scheduleCancel', ref, confirmed };
    }

    const timeText = firstArg;
    const target = String(args[1] ?? '').trim();
    const parts = args.slice(2);
    let remaining = null;
    let endText = '';
    let forever = false;

    // 从末尾剥离可选条件：[连续7天] / [共10次] / [到2026-10-28] / [永久]。
    while (parts.length) {
      const last = String(parts[parts.length - 1] ?? '').trim();
      const count = parseCountOption(last);
      if (count) {
        parts.pop();
        if (count.kind === 'forever') forever = true;
        else remaining = count.count;
        continue;
      }
      if (isEndOption(last)) {
        parts.pop();
        endText = last;
        continue;
      }
      break;
    }
    if (forever) { remaining = null; endText = ''; }

    const content = parts.join(' ').trim();
    if (!timeText || !target || !content) {
      return { ok: false, action: 'schedule', error: 'missing-args' };
    }
    if (content.length > 500) return { ok: false, action: 'schedule', error: 'content-too-long' };
    return {
      ok: true, action: 'schedule', timeText, target, content,
      ...(remaining !== null ? { remaining } : {}),
      ...(endText ? { endText } : {})
    };
  }

  // ── 查询模型余额 ──────────────────────────────────────────────────────
  if (['查询模型余额', '模型余额', '查模型余额', '模型账户余额'].includes(key)) {
    const raw = String(args[0] ?? '').trim();
    if (!raw) return { ok: true, action: 'modelBalanceList' };
    return { ok: true, action: 'modelBalance', provider: providerOf(raw), raw };
  }

  return { ok: false };
}

// ── 格式化 ──────────────────────────────────────────────────────────────

/** 参数不足/格式不对时的用法提示。 */
export function formatOwnerActionUsage(cmd = {}) {
  const usage = {
    emojiLike: '[消息表情回应][消息id][表情id] / [取消表情回应][消息id][表情id]',
    wake: '[主动唤醒][群号/群名/QQ号/好友名]',
    talk: '[主动对话][目标][内容]',
    proactiveStatus: '[主动状态][群号/群名/QQ号/好友名]，或 [主动开关][目标][on|off]',
    proactiveToggle: '[主动开关][目标][on|off]；也可 [关闭主动][目标] / [开启主动][目标]',
    limitAdjust: '[限额调整][私聊|群聊][每分钟|每小时|每天][数值]，或 [限额调整][私聊][20/200/500]',
    limitReset: '[限额重置][群号/群名/QQ号/好友名]',
    schedule: '[定时任务][时间][目标][内容][连续N天|共N次|到日期|永久]；[定时任务][查看所有]；[定时任务][取消 序号或id]',
    scheduleCancel: '[定时任务][取消 序号] / [定时任务][取消 r_xxxxxxxx] / [定时任务][取消 全部 确认]',
    scheduleList: '发 [定时任务][查看所有] 查看正在运行的任务。',
    scheduleHelp: '发 [高级帮助] 或 [定时任务][查看所有] 查看用法。'
  };
  const reason = cmd.error === 'content-too-long' ? '内容最多 500 字。' : '参数不够或格式不对。';
  return `${reason}\n用法：${usage[cmd.action] || '发 [高级帮助] 查看全部用法。'}`;
}

export function formatEmojiLikeResult({ messageId, emojiId, set = true, ok = true, error = '' } = {}) {
  if (!ok) return `表情回应失败：${String(error || '未知错误').slice(0, 120)}`;
  return set
    ? `已给消息 ${messageId} 添加表情回应 ${emojiId}。`
    : `已取消消息 ${messageId} 的表情回应 ${emojiId}。`;
}

export function formatWakeResult({ target, ok = true, queued = false, error = '' } = {}) {
  if (!ok && !queued) return `主动唤醒失败：${String(error || '未知错误').slice(0, 120)}`;
  return queued
    ? `已给 ${target} 排队一次主动唤醒（当前会话忙，忙完会补投）。`
    : `已唤醒 ${target}，让它自己决定要不要说话。`;
}

export function formatTalkResult({ target, ok = true, queued = false, error = '' } = {}) {
  if (!ok && !queued) return `主动对话失败：${String(error || '未知错误').slice(0, 120)}`;
  return queued
    ? `已给 ${target} 排队一条主动对话，忙完会补投。`
    : `已让 ${target} 按你的要求主动开口。`;
}

export function formatProactiveStatus({
  target = '未知目标', enabled = true, lastText = '', ageText = '',
  maxIdleDays = 3, blockReason = ''
} = {}) {
  let state = '正常';
  if (blockReason === 'switch-off') state = '已关闭（手动）';
  else if (blockReason === 'no-incoming') state = '已暂停（还没收到过对方消息）';
  else if (String(blockReason).startsWith('stale:')) state = `已暂停（超过 ${maxIdleDays} 天没对话）`;
  return [
    `【主动问候】${target}`,
    `开关：${enabled ? '开启' : '关闭'}`,
    `上次对方发言：${lastText || '从未'}${ageText ? `（${ageText}）` : ''}`,
    `当前状态：${state}`,
    '说明：只停「主动机会/饭点」两类；提醒和到点跟进不受影响。',
    '切换：[主动开关 目标 on|off] / [关闭主动 目标] / [开启主动 目标]'
  ].join('\n');
}

export function formatProactiveToggle({ target = '未知目标', enabled = true, blockReason = '', maxIdleDays = 3 } = {}) {
  if (!enabled) return `已关闭 ${target} 的主动问候。`;
  if (String(blockReason).startsWith('stale:')) {
    return `已开启 ${target} 的主动问候；但它已超过 ${maxIdleDays} 天没对话，仍会自动暂停，等对方回一条消息后恢复。`;
  }
  if (blockReason === 'no-incoming') {
    return `已开启 ${target} 的主动问候；它还没有收到过对方消息，暂时不会主动开口。`;
  }
  return `已开启 ${target} 的主动问候。`;
}

export function formatLimitStatus({ privateLimits = {}, groupLimits = {}, scope = '' } = {}) {
  const show = (value) => (Number(value) === 0 ? '不限' : (value ?? '未知'));
  const row = (label, l) => `  ${label}：每分钟 ${show(l.perMinute)}｜每小时 ${show(l.perHour)}｜每天 ${show(l.perDay)}`;
  const lines = ['【发送限额】'];
  if (!scope || scope === 'private') lines.push(row('私聊', privateLimits));
  if (!scope || scope === 'group') lines.push(row('群聊', groupLimits));
  lines.push('');
  lines.push('调整（0 = 不限）：');
  lines.push('  [限额调整][私聊][每分钟][20]');
  lines.push('  [限额调整][群聊][每小时][200]');
  lines.push('  [限额调整][私聊][每天][500]');
  lines.push('  [限额调整][私聊][20/200/500]   一次设置分钟/小时/天');
  lines.push('重置某个会话今天的计数：');
  lines.push('  [限额重置][群号或群名] / [限额重置][QQ号或好友名]');
  return lines.join('\n');
}

export function formatLimitChange({ scope, window, value, minute, hour, day, all = false } = {}) {
  const label = SCOPE_LABELS[scope] || '会话';
  const show = (v) => (Number(v) === 0 ? '不限' : `${v} 条`);
  if (all) {
    return `已把${label}限额改为：每分钟 ${show(minute)}｜每小时 ${show(hour)}｜每天 ${show(day)}。`;
  }
  return `已把${label}限额的${WINDOW_LABELS[window] || '发送量'}改为 ${show(value)}。`;
}

export function formatLimitReset({ target, removed = 0, ok = true, error = '' } = {}) {
  if (!ok) return `限额重置失败：${String(error || '未知错误').slice(0, 120)}`;
  return `已重置 ${target} 今天的发送计数（移除 ${removed} 条记录）；审计日志不受影响。`;
}

export function formatScheduleResult({
  id, atText, target, content = '', repeatText = '', remaining = null, endText = '',
  ok = true, error = ''
} = {}) {
  if (!ok) return `定时任务创建失败：${String(error || '未知错误').slice(0, 120)}`;
  const body = String(content || '').replace(/\s+/g, ' ').slice(0, 60);
  const rule = [];
  if (repeatText && repeatText !== '一次性') {
    rule.push(repeatText);
    if (Number(remaining) > 0) rule.push(`共 ${remaining} 次`);
    else if (endText) rule.push(`到 ${endText}`);
    else rule.push('长期，直到取消');
  } else if (endText) {
    rule.push(`到 ${endText}`);
  }
  const suffix = rule.length ? `（${rule.join('，')}）` : '';
  return `已创建定时任务 ${id}：${atText}${suffix} → ${target}${body ? `｜${body}${content.length > 60 ? '…' : ''}` : ''}\n查看：[定时任务][查看所有]；取消：[定时任务][取消 ${id}]。`;
}

export function formatScheduleList({ items = [] } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it === 'object');
  if (!list.length) {
    return [
      '【定时任务】当前没有定时任务。',
      '新建：[定时任务][每天8点][示例好友甲][说早安][连续7天]',
      '一次性：[定时任务][明天早上8点][示例好友甲][说早安]',
      '限制：[连续7天] / [共10次] / [到2026-10-28] / [永久]（可省略，省略=长期直到取消）'
    ].join('\n');
  }

  const lines = [`【定时任务】${list.length} 条`];
  list.forEach((it, index) => {
    const repeat = String(it.repeatText || '').trim();
    const rule = [];
    let when = String(it.atText || '');
    if (repeat && repeat !== '一次性') {
      when = `${String(it.ruleText || repeat)}｜下次 ${it.atText}`;
      if (Number(it.remaining) > 0) rule.push(`剩 ${it.remaining} 次`);
      else if (it.endText) rule.push(`到 ${it.endText}`);
      else rule.push('长期');
    } else if (it.endText) {
      rule.push(`到 ${it.endText}`);
    }
    const body = String(it.content || '').replace(/\s+/g, ' ').slice(0, 60);
    lines.push(`${index + 1}. ${it.id}｜${it.paused ? '【已暂停】' : ''}${when}${rule.length ? `｜${rule.join('｜')}` : ''}｜→ ${it.target}`);
    if (body) lines.push(`   ${body}`);
  });
  lines.push('', '取消：[定时任务][取消 序号] 或 [定时任务][取消 r_xxx]；全部取消：[定时任务][取消 全部 确认]。', '编辑：[任务改期][r_xxx][明天9点] / [任务内容][r_xxx][新内容]；[暂停任务][r_xxx] / [恢复任务][r_xxx] / [任务顺延][r_xxx][30分钟]。');
  return lines.join('\n');
}

export function formatScheduleCancel({ id = '', atText = '', target = '', count = 0, all = false, ok = true, error = '' } = {}) {
  if (!ok) return `取消定时任务失败：${String(error || '未知错误').slice(0, 120)}`;
  if (all) return `已取消全部 ${count} 条定时任务。`;
  return `已取消定时任务 ${id}${atText ? `（原定 ${atText}${target ? `，${target}` : ''}）` : ''}。`;
}

export function formatScheduleCandidates({ ref = '', candidates = [] } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((x) => x && typeof x === 'object');
  const lines = [`「${ref}」匹配到 ${list.length} 条定时任务，请用序号或 id 取消：`];
  list.slice(0, 10).forEach((it, index) => {
    lines.push(`  ${index + 1}. ${it.id}｜${it.atText}｜→ ${it.target}｜${String(it.content || '').slice(0, 40)}`);
  });
  if (list.length > 10) lines.push(`只显示前 10 条（共 ${list.length} 条）。`);
  lines.push('例：[定时任务][取消 r_xxxxxxxx]');
  return lines.join('\n');
}

export function formatModelBalanceList({ deepseekConfigured = false, qwenConfigured = false, doubaoConfigured = false, xiaomiConfigured = false } = {}) {
  return [
    '【查询模型余额】',
    `  DeepSeek：${deepseekConfigured ? '已配置，可查询' : '未配置 key'}`,
    `  千问/百炼：${qwenConfigured ? '已配置 API key（无基于 key 的余额接口）' : '未配置 key'}`,
    `  豆包/火山：${doubaoConfigured ? '已配置 API key（无基于 key 的余额接口）' : '未配置 key'}`,
    `  小米 MiMo：${xiaomiConfigured ? '已配置 key（未提供余额接口）' : '未配置 key'}`,
    '',
    '用法：[查询模型余额][deepseek] / [千问] / [豆包] / [小米]'
  ].join('\n');
}
