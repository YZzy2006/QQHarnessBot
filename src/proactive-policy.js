// 主动问候策略：纯函数，不做 I/O。
//
// 两类主动渠道受这里控制：
//   - proactiveCheck（随机/主动找话题）
//   - mealTime（饭点主动冒泡）
// followup（约定到点跟进）和 reminders 不受影响。

export const DEFAULT_MAX_IDLE_DAYS = 3;

/**
 * 返回阻止主动问候的原因；空字符串表示允许。
 * @param {object} opts
 * @param {boolean} [opts.enabled] 单会话开关；false 直接阻止
 * @param {number} [opts.lastIncomingAt] 最后一次收到对方消息的时间
 * @param {number} [opts.now]
 * @param {number} [opts.maxIdleDays] 超过多少天没对话就暂停；默认 3
 * @returns {''|'switch-off'|'no-incoming'|`stale:${number}`}
 */
export function proactiveGreetingBlockReason({
  enabled = true,
  lastIncomingAt = 0,
  quietUntil = 0,
  now = Date.now(),
  maxIdleDays = DEFAULT_MAX_IDLE_DAYS
} = {}) {
  if (enabled === false) return 'switch-off';
  if (Number(quietUntil) > Number(now)) return `quiet:${Number(quietUntil)}`;

  const last = Number(lastIncomingAt) || 0;
  if (!last) return 'no-incoming';

  const days = Number(maxIdleDays) > 0 ? Number(maxIdleDays) : DEFAULT_MAX_IDLE_DAYS;
  const age = Number(now) - last;
  if (!Number.isFinite(age) || age < 0) return '';
  if (age > days * 86400000) return `stale:${days}`;
  return '';
}

/** 给日志/回复用的中文说明。 */
export function describeProactiveBlock(reason) {
  const s = String(reason || '');
  if (!s) return '正常';
  if (s === 'switch-off') return '该会话已手动关闭主动问候';
  if (s === 'no-incoming') return '还没有收到过对方消息';
  if (s.startsWith('quiet:')) return '临时免打扰中，到期自动恢复';
  if (s.startsWith('stale:')) return `超过 ${s.slice(6)} 天没有对话`;
  return s;
}
