// Bridge 可靠性纯策略：不碰文件/网络/模型，方便单元测试。
// 这些阈值与 bridge.js 的行为保持一致；测试在 scripts/test-reliability.mjs。

export const PENDING_WAKE_TTL_MS = 30 * 60 * 1000;
export const PENDING_WAKE_MAX = 20;
export const TURN_WATCHDOG_WARN_MS = 15 * 60 * 1000;
export const TURN_WATCHDOG_RELEASE_MS = 30 * 60 * 1000;

/**
 * 只保留“30 分钟内、对应消息仍在 unread”的待唤醒原因；按优先级选一条。
 * 返回的 kept 会被写回 state，chosen 用于启动补发。
 */
export function selectPendingWakeReasons({
  pendingWakeReasons,
  unread,
  now = Date.now(),
  ttlMs = PENDING_WAKE_TTL_MS,
  max = PENDING_WAKE_MAX,
  priority = () => 0
} = {}) {
  const unreadSeqs = new Set(
    (Array.isArray(unread) ? unread : [])
      .map((m) => Number(m && m.seq))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  const kept = [];
  for (const item of Array.isArray(pendingWakeReasons) ? pendingWakeReasons : []) {
    if (!item || typeof item !== 'object' || typeof item.reason !== 'string') continue;
    const at = Number(item.at);
    const seq = Number(item.seq);
    if (!Number.isFinite(at) || now - at > ttlMs) continue;
    if (Number.isFinite(seq) && seq > 0 && !unreadSeqs.has(seq)) continue;
    kept.push({
      reason: item.reason.slice(0, 80),
      seq: Number.isFinite(seq) ? seq : 0,
      at
    });
  }
  const limit = Math.max(1, Number(max) || PENDING_WAKE_MAX);
  const limited = kept.slice(-limit);
  let chosen = null;
  for (const item of limited) {
    if (!chosen || Number(priority(item.reason)) > Number(priority(chosen.reason))) chosen = item;
  }
  return { kept: limited, chosen };
}

/**
 * 根据当前内存中的 turn/collector/最后活动时间，给出 warn/release 动作。
 * - 15 分钟无活动：warn（同一 session 30 分钟内只一次）
 * - 30 分钟无活动：release
 *
 * 关键：卡住判据是“最后活动时间”，不是“turn 开始时间”。一个正常的长回合
 * 可能持续 20 分钟，但期间一直在 call tool / send / wait 返回；只看开始时间
 * 会把活跃回合误报成卡死（2026-10-19 17:31 owner 告警就是结束前 3 秒误报）。
 */
export function planTurnWatchdog({
  now = Date.now(),
  sessions = [],
  warnMs = TURN_WATCHDOG_WARN_MS,
  releaseMs = TURN_WATCHDOG_RELEASE_MS
} = {}) {
  const actions = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s) continue;
    const starts = [s.turnStartAt, s.collectorStartedAt]
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!starts.length) continue;
    const startedAt = Math.min(...starts);
    const activity = Number(s.lastActivityAt);
    const anchor = Number.isFinite(activity) && activity > 0
      ? Math.max(activity, startedAt)
      : startedAt;
    const ageMs = now - anchor;
    if (!Number.isFinite(ageMs) || ageMs < warnMs) continue;
    const base = { sessionId: s.sessionId, key: s.key || '', ageMs };
    if (ageMs >= releaseMs) {
      actions.push({ ...base, type: 'release' });
    } else if (now - (Number(s.lastAlertAt) || 0) >= releaseMs) {
      actions.push({ ...base, type: 'warn' });
    }
  }
  return actions;
}
