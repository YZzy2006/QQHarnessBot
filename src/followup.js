// Open-loop follow-up policy for social-v2 activeTopics.
//
// An activeTopic becomes an open loop when it has `status: 'open'` and a
// `dueAt` timestamp. The bridge nudges it at most once, only outside quiet
// hours and only when the conversation has been idle. Any user reply after
// the nudge closes it. All functions here are pure so they can be tested
// without DSH, SnowLuma, or production state.

const DAY_MS = 24 * 60 * 60 * 1000;

export const FOLLOWUP_DEFAULTS = Object.freeze({
  staleMs: 7 * DAY_MS,
  replyCloseMs: 48 * 60 * 60 * 1000,
  globalCooldownMs: 12 * 60 * 60 * 1000,
  maxNudges: 1,
  startHour: 8,
  endHour: 23,
  futureLimitMs: 400 * DAY_MS
});

/**
 * Normalize a model/user supplied due time to milliseconds.
 * Accepts:
 *   - 13-digit ms or 10-digit seconds (number or numeric string)
 *   - ISO 8601 with timezone, e.g. 2026-10-19T19:00:00+08:00
 *   - "YYYY-MM-DD HH:mm[:ss]" without timezone -> Beijing time
 *   - "YYYY-MM-DD" -> 20:00 Beijing (a date alone is too vague for a morning nudge)
 * Returns null for invalid or absurd values.
 */
export function parseDueAt(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  let ms = NaN;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d{10,13}$/.test(s)) {
      const n = Number(s);
      ms = n < 1e12 ? n * 1000 : n;
    } else {
      let text = s;
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        text = `${text}T20:00:00+08:00`;
      } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
        text = `${text.replace(' ', 'T')}+08:00`;
      }
      ms = Date.parse(text);
    }
  }
  if (!Number.isFinite(ms)) return null;
  if (ms < now - FOLLOWUP_DEFAULTS.staleMs) return null;
  if (ms > now + FOLLOWUP_DEFAULTS.futureLimitMs) return null;
  return Math.round(ms);
}

export function isOpenFollowUp(topic) {
  return !!topic && typeof topic === 'object'
    && String(topic.status || '') === 'open'
    && Number(topic.dueAt) > 0
    && String(topic.text || '').trim().length > 0;
}

/**
 * Pick one due loop, or null. Only the earliest due loop is returned.
 * A global cooldown prevents nudging two promises back-to-back; the same
 * loop is capped at `maxNudges` (default 1).
 */
export function selectDueFollowUp(topics, now = Date.now(), options = {}) {
  const staleMs = Number.isFinite(Number(options.staleMs))
    ? Number(options.staleMs)
    : FOLLOWUP_DEFAULTS.staleMs;
  const cooldownMs = Number.isFinite(Number(options.globalCooldownMs))
    ? Number(options.globalCooldownMs)
    : FOLLOWUP_DEFAULTS.globalCooldownMs;
  const maxNudges = Number.isFinite(Number(options.maxNudges))
    ? Number(options.maxNudges)
    : FOLLOWUP_DEFAULTS.maxNudges;

  const list = Array.isArray(topics) ? topics.filter(isOpenFollowUp) : [];
  if (!list.length) return null;

  const lastNudge = list.reduce((max, t) => Math.max(max, Number(t.lastNudgedAt) || 0), 0);
  if (lastNudge > 0 && now - lastNudge < cooldownMs) return null;

  return list
    .filter((t) => Number(t.dueAt) <= now)
    .filter((t) => now - Number(t.dueAt) <= staleMs)
    .filter((t) => Math.max(Number(t.nudgeCount) || 0, Number(t.lastNudgedAt) > 0 ? 1 : 0) < maxNudges)
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))[0] || null;
}

export function markFollowUpNudged(topic, now = Date.now()) {
  if (!isOpenFollowUp(topic)) return false;
  const prior = Math.max(Number(topic.nudgeCount) || 0, Number(topic.lastNudgedAt) > 0 ? 1 : 0);
  topic.lastNudgedAt = now;
  topic.nudgeCount = prior + 1;
  return true;
}

/**
 * Close open loops when the user replies. A loop that was already nudged is
 * closed by any reply within `replyCloseMs`; a loop mentioned by the user is
 * closed even before the nudge (they brought it up themselves).
 * `hitTopics` contains the same object references as in the topics array.
 */
export function closeFollowUpsOnReply(topics, {
  now = Date.now(),
  hitTopics = [],
  closeNudgedMs = FOLLOWUP_DEFAULTS.replyCloseMs
} = {}) {
  const hits = new Set(Array.isArray(hitTopics) ? hitTopics : []);
  let closed = 0;
  for (const t of Array.isArray(topics) ? topics : []) {
    if (!isOpenFollowUp(t)) continue;
    const nudged = Number(t.lastNudgedAt) > 0 && now - Number(t.lastNudgedAt) <= closeNudgedMs;
    const hit = hits.has(t);
    if (!hit && !nudged) continue;
    t.status = 'done';
    t.doneAt = now;
    t.closedBy = hit ? 'topic_mentioned' : 'user_reply';
    closed += 1;
  }
  return closed;
}

/**
 * Retention: legacy topics live 24h after their last mention; open loops live
 * until their due time plus the stale window. Done loops live 24h after being
 * closed. A missing lastMentionAt is kept (legacy behavior).
 */
export function shouldKeepTopic(topic, now = Date.now()) {
  if (!topic || typeof topic !== 'object') return false;
  const mention = Number(topic.lastMentionAt) || 0;
  if (isOpenFollowUp(topic)) {
    const anchor = Math.max(mention, Number(topic.dueAt) || 0);
    return now - anchor < FOLLOWUP_DEFAULTS.staleMs;
  }
  const anchor = Math.max(mention, Number(topic.doneAt) || 0);
  return !anchor || now - anchor < DAY_MS;
}

export function followUpWindowOpen(hour, {
  startHour = FOLLOWUP_DEFAULTS.startHour,
  endHour = FOLLOWUP_DEFAULTS.endHour
} = {}) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  return h >= startHour && h < endHour;
}
