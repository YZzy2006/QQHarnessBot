// Per-session image generation quota and explicit-request gate.
// Pure functions; the bridge persists the timestamp arrays in
// state/image-gen-quota.json.

export const IMAGE_QUOTA_LIMITS = Object.freeze({
  perHour: 5,
  perDay: 15,
  cooldownMs: 60 * 1000
});

// Global guard across all sessions: one chat cannot burn the whole day.
export const IMAGE_GLOBAL_LIMITS = Object.freeze({
  perHour: 8,
  perDay: 20,
  cooldownMs: 0
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const IMAGE_REQUEST_RE = /(画|图|照片|海报|配图|生成|来一张|整一张|draw|image|picture|photo)/i;

export function pruneImageQuota(list, now = Date.now()) {
  const nowMs = Number(now);
  return (Array.isArray(list) ? list : [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > 0 && nowMs - t < DAY_MS)
    .sort((a, b) => a - b);
}

/**
 * Check cooldown/hour/day. Returns `reason`:
 *   cooldown | hour | day | ''
 * The per-session limit has a 60s cooldown; the global guard passes 0.
 */
export function checkImageQuota(list, now = Date.now(), limits = IMAGE_QUOTA_LIMITS) {
  const nowMs = Number(now);
  const kept = pruneImageQuota(list, nowMs);
  const hourCount = kept.filter((t) => nowMs - t < HOUR_MS).length;
  const dayCount = kept.length;
  const cooldownMs = Number.isFinite(Number(limits.cooldownMs))
    ? Number(limits.cooldownMs)
    : IMAGE_QUOTA_LIMITS.cooldownMs;
  const lastAt = kept.length ? kept[kept.length - 1] : 0;

  let reason = '';
  let retryAfterMs = 0;
  if (lastAt > 0 && cooldownMs > 0 && nowMs - lastAt < cooldownMs) {
    reason = 'cooldown';
    retryAfterMs = Math.max(1000, cooldownMs - (nowMs - lastAt));
  } else if (hourCount >= limits.perHour) {
    reason = 'hour';
    const oldest = kept.find((t) => nowMs - t < HOUR_MS);
    retryAfterMs = Math.max(1000, HOUR_MS - (nowMs - (oldest || nowMs)));
  } else if (dayCount >= limits.perDay) {
    reason = 'day';
    const oldest = kept[0];
    retryAfterMs = Math.max(1000, DAY_MS - (nowMs - (oldest || nowMs)));
  }

  return {
    ok: !reason,
    reason,
    hourCount,
    dayCount,
    retryAfterMs,
    limits,
    kept
  };
}

export function recordImageQuota(list, now = Date.now()) {
  const kept = pruneImageQuota(list, now);
  kept.push(Number(now));
  return kept;
}

/**
 * Find a recent non-self message that contains the user's original image
 * request. The model must pass the actual quote, not a paraphrase; this is the
 * hard gate that prevents proactive/spontaneous image generation.
 */
export function findRecentImageRequest(messages, requestText, now = Date.now(), {
  windowMs = REQUEST_WINDOW_MS
} = {}) {
  const text = String(requestText || '').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > 200) {
    return { ok: false, reason: 'invalid_request_text' };
  }
  const nowMs = Number(now);
  const cutoff = nowMs - Math.max(0, Number(windowMs) || REQUEST_WINDOW_MS);
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (!msg || msg.isSelf) continue;
    const at = Number(msg.time) || 0;
    if (at < cutoff) continue;
    const body = String(msg.plain ?? msg.text ?? msg.tail ?? '').replace(/\s+/g, ' ');
    if (!body.includes(text)) continue;
    if (!IMAGE_REQUEST_RE.test(body)) continue;
    return { ok: true, message: msg };
  }
  return { ok: false, reason: 'not_found' };
}
