// 好友申请 / 新好友来源：纯策略，不做 I/O。
//
// 事件来源（SnowLuma OneBot）：
//   request.friend     对方申请加机器人：user_id / comment(验证消息) / flag
//   notice.friend_add  机器人新增了好友：user_id
//
// QQ 没有“历史上谁先加谁”的查询接口；这里只记录部署后收到的事件。
// 没有匹配到申请记录的 friend_add 标为 source=unknown，不猜测、不让模型乱问。

const MAX_REQUESTS = 100;
const MAX_FRIENDS = 500;
const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function bjText(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function bjShort(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired', 'added']);

function normalizeRequest(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  if (!r) return null;
  const flag = String(r.flag ?? '');
  const id = String(r.id ?? '');
  if (!flag && !id) return null;
  return {
    id: id || `fr_${flag.slice(-6)}`,
    flag,
    uin: toInt(r.uin),
    nickname: truncate(r.nickname, 60),
    comment: truncate(r.comment, 200),
    receivedAt: toInt(r.receivedAt),
    status: REQUEST_STATUSES.has(String(r.status)) ? String(r.status) : 'pending',
    handledAt: toInt(r.handledAt),
    addedAt: toInt(r.addedAt),
    source: String(r.source ?? 'request')
  };
}

function normalizeFriend(raw, keyUin = 0) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const uin = toInt(r.uin) || toInt(keyUin);
  if (!uin) return null;
  return {
    uin,
    nickname: truncate(r.nickname, 60),
    remark: truncate(r.remark, 60),
    addedAt: toInt(r.addedAt),
    direction: r.direction === 'incoming' || r.direction === 'outgoing' ? r.direction : 'unknown',
    comment: truncate(r.comment, 200),
    requestId: String(r.requestId ?? ''),
    source: String(r.source ?? 'notice'),
    note: truncate(r.note, 200)
  };
}

/** 读取/首次创建时的归一化。 */
export function normalizeFriendRequestState(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const requests = [];
  for (const item of Array.isArray(r.requests) ? r.requests : []) {
    const rec = normalizeRequest(item);
    if (rec) requests.push(rec);
  }
  requests.sort((a, b) => a.receivedAt - b.receivedAt);
  const friends = {};
  for (const [key, value] of Object.entries(r.friends && typeof r.friends === 'object' ? r.friends : {})) {
    const rec = normalizeFriend(value, key);
    if (rec) friends[rec.uin] = rec;
  }
  const snapshot = r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : {};
  return {
    requests: requests.slice(-MAX_REQUESTS),
    friends,
    snapshot: {
      at: toInt(snapshot.at),
      uins: Array.isArray(snapshot.uins)
        ? [...new Set(snapshot.uins.map((n) => toInt(n)).filter(Boolean))]
        : []
    }
  };
}

/** 记录一条好友申请；同一个 flag 重复推送时只更新，不产生重复记录。 */
export function upsertFriendRequest(state, { id, flag, uin, nickname, comment, at }) {
  const f = String(flag ?? '');
  const u = toInt(uin);
  const now = toInt(at) || Date.now();
  let rec = f
    ? state.requests.find((x) => x.flag === f)
    : state.requests.find((x) => u > 0 && x.uin === u && x.status === 'pending');
  if (rec) {
    if (u > 0) rec.uin = u;
    if (nickname) rec.nickname = truncate(nickname, 60);
    if (comment) rec.comment = truncate(comment, 200);
    if (rec.status === 'expired' || rec.status === 'rejected') {
      rec.status = 'pending';
      rec.receivedAt = now;
      rec.handledAt = 0;
    }
    return rec;
  }
  rec = {
    id: String(id ?? ''),
    flag: f,
    uin: u,
    nickname: truncate(nickname, 60),
    comment: truncate(comment, 200),
    receivedAt: now,
    status: 'pending',
    handledAt: 0,
    addedAt: 0,
    source: 'request'
  };
  if (!rec.id) rec.id = `fr_${f.slice(-6) || String(now).slice(-6)}`;
  state.requests.push(rec);
  if (state.requests.length > MAX_REQUESTS) {
    state.requests.splice(0, state.requests.length - MAX_REQUESTS);
  }
  return rec;
}

/** 超过 7 天的待处理申请标记为过期（QQ 侧申请本身也会过期）。 */
export function pruneFriendRequests(state, now = Date.now()) {
  for (const rec of state.requests) {
    if (rec.status === 'pending' && now - rec.receivedAt > PENDING_TTL_MS) {
      rec.status = 'expired';
    }
  }
  return state;
}

export function pendingFriendRequests(state, now = Date.now()) {
  pruneFriendRequests(state, now);
  return state.requests.filter((rec) => rec.status === 'pending');
}

/** 按 #id / 序号 / QQ 号找到待处理申请。 */
export function resolveFriendRequestReference(state, ref, now = Date.now()) {
  const s = String(ref ?? '').trim().replace(/^#/, '');
  if (!s) return null;
  if (/^fr_[0-9a-z]+$/i.test(s)) {
    return state.requests.find((rec) => rec.id.toLowerCase() === s.toLowerCase()) || null;
  }
  if (/^\d{1,3}$/.test(s)) {
    const pending = pendingFriendRequests(state, now);
    return pending[Number(s) - 1] || null;
  }
  if (/^\d{5,12}$/.test(s)) {
    return [...state.requests].reverse().find((rec) => rec.uin === Number(s) && rec.status === 'pending') || null;
  }
  return null;
}

export function markFriendRequestHandled(state, id, status, at = Date.now()) {
  const rec = state.requests.find((x) => x.id === id);
  if (!rec) return null;
  rec.status = status;
  rec.handledAt = toInt(at) || Date.now();
  return rec;
}

/**
 * 记录“新增了好友”。能对上已通过/待处理的申请 → direction=incoming + 验证消息；
 * 对不上 → direction=unknown（不猜测来源）。
 */
export function recordFriendAdded(state, uin, at = Date.now(), extra = {}) {
  const u = toInt(uin);
  if (!u) return null;
  const now = toInt(at) || Date.now();
  const match = [...state.requests].reverse().find((rec) =>
    rec.uin === u && (rec.status === 'approved' || rec.status === 'pending')
  );
  const prev = state.friends[u] || null;
  let direction = 'unknown';
  let source = 'notice';
  let comment = '';
  let requestId = '';
  if (match) {
    match.status = 'added';
    match.addedAt = now;
    if (!match.handledAt) match.handledAt = now;
    direction = 'incoming';
    source = 'friend-request';
    comment = match.comment;
    requestId = match.id;
  }
  const rec = normalizeFriend({
    uin: u,
    nickname: extra.nickname || prev?.nickname || '',
    remark: extra.remark || prev?.remark || '',
    addedAt: prev?.addedAt || now,
    // 手动标注（尤其是“我加对方”）优先，不能被后来的 notice 覆盖。
    direction: prev?.source === 'manual'
      ? prev.direction
      : (prev?.direction === 'incoming' ? 'incoming' : direction),
    comment: prev?.source === 'manual' ? prev.comment : (prev?.comment || comment),
    requestId: prev?.requestId || requestId,
    source: prev?.source && prev.source !== 'notice' ? prev.source : source,
    note: prev?.note || (match ? '' : '没有匹配到好友申请记录')
  });
  state.friends[u] = rec;
  // 只保留最近 500 条好友来源记录，避免文件无限增长。
  const entries = Object.values(state.friends).sort((a, b) => b.addedAt - a.addedAt);
  if (entries.length > MAX_FRIENDS) {
    const keep = new Set(entries.slice(0, MAX_FRIENDS).map((x) => String(x.uin)));
    for (const key of Object.keys(state.friends)) {
      if (!keep.has(key)) delete state.friends[key];
    }
  }
  return rec;
}

export function friendRecordForUin(state, uin) {
  const u = toInt(uin);
  if (!u) return null;
  if (state.friends[u]) return state.friends[u];
  // friend_add 事件可能比第一条私聊晚到：已通过的申请也能提供来源。
  const rec = [...state.requests].reverse().find((x) =>
    x.uin === u && (x.status === 'approved' || x.status === 'added' || x.status === 'pending')
  );
  if (!rec) return null;
  return {
    uin: u,
    nickname: rec.nickname,
    remark: '',
    addedAt: rec.addedAt || rec.handledAt || 0,
    receivedAt: rec.receivedAt,
    status: rec.status,
    direction: 'incoming',
    comment: rec.comment,
    requestId: rec.id,
    source: 'friend-request',
    note: ''
  };
}

/** 给好友列表里的每个好友建立来源占位记录（不通知）。 */
export function ensureFriendRecord(state, friend) {
  const uin = toInt(friend?.uin ?? friend?.user_id);
  if (!uin) return null;
  if (state.friends[uin]) return state.friends[uin];
  state.friends[uin] = normalizeFriend({
    uin,
    nickname: friend?.nickname,
    remark: friend?.remark,
    addedAt: 0,
    direction: 'unknown',
    comment: '',
    requestId: '',
    source: 'friend-list',
    note: ''
  });
  return state.friends[uin];
}

/** owner 手动标注好友来源：direction = incoming|outgoing|unknown。 */
export function annotateFriendSource(state, uin, { direction, comment, nickname, remark } = {}) {
  const u = toInt(uin);
  if (!u) return null;
  const prev = state.friends[u] || {};
  const dir = direction === 'incoming' || direction === 'outgoing' ? direction : 'unknown';
  const rec = normalizeFriend({
    uin: u,
    nickname: nickname || prev.nickname || '',
    remark: remark || prev.remark || '',
    addedAt: prev.addedAt || 0,
    direction: dir,
    comment: comment !== undefined && comment !== '' ? comment : (prev.comment || ''),
    requestId: prev.requestId || '',
    source: 'manual',
    note: ''
  });
  state.friends[u] = rec;
  return rec;
}

/** 对比好友列表快照；首次运行只建快照，不把现有好友当新好友。 */
export function diffFriendSnapshot(state, uins, at = Date.now()) {
  const current = [...new Set((Array.isArray(uins) ? uins : []).map((n) => toInt(n)).filter(Boolean))];
  const prev = new Set(state.snapshot.uins);
  const firstRun = !state.snapshot.at;
  const added = firstRun ? [] : current.filter((uin) => !prev.has(uin));
  state.snapshot = { at: toInt(at) || Date.now(), uins: current };
  return { added, firstRun };
}

export function formatFriendRequestNotice(rec) {
  const qq = rec.uin > 0 ? String(rec.uin) : `未知（uid ${String(rec.flag || '').slice(0, 12)}…）`;
  const nick = rec.nickname ? `昵称：${rec.nickname}\n` : '';
  return [
    `【好友申请】${rec.id}`,
    `QQ：${qq}`,
    nick + `验证消息：${rec.comment ? `「${rec.comment}」` : '（无）'}`,
    '方向：对方申请加你（对方 → 你）',
    `时间：${bjText(rec.receivedAt)}`,
    `回 [通过申请 ${rec.id}] 或 [拒绝申请 ${rec.id}]`
  ].join('\n');
}

export function formatFriendRequestList(state, now = Date.now()) {
  const pending = pendingFriendRequests(state, now);
  if (!pending.length) return '当前没有待处理的好友申请。\n发 [好友申请帮助] 看用法。';
  const lines = [`【待处理好友申请】${pending.length} 条`];
  pending.forEach((rec, i) => {
    const qq = rec.uin > 0 ? `QQ ${rec.uin}` : `QQ 未知（uid ${String(rec.flag || '').slice(0, 12)}…）`;
    const nick = rec.nickname ? `（${rec.nickname}）` : '';
    lines.push(`${i + 1}. ${rec.id}  ${qq}${nick}  ${bjShort(rec.receivedAt)}`);
    lines.push(`   验证消息：${rec.comment ? `「${rec.comment}」` : '（无）'}`);
  });
  lines.push('回 [通过申请 1] / [拒绝申请 1]（序号或 #id 都可以）');
  return lines.join('\n');
}

export function formatFriendAddedNotice(rec) {
  if (!rec) return '';
  const who = rec.remark || rec.nickname
    ? `QQ ${rec.uin}${rec.remark ? `（备注：${rec.remark}）` : `（${rec.nickname}）`}`
    : `QQ ${rec.uin}`;
  if (rec.direction === 'incoming') {
    return [
      `【新好友】${who} 已成为好友。`,
      `来源：对方申请加你${rec.comment ? `，验证消息「${rec.comment}」` : '（无验证消息）'}，已通过。`,
      `时间：${bjText(rec.addedAt)}`
    ].join('\n');
  }
  return [
    `【新好友】${who} 已成为好友。`,
    '来源：没匹配到好友申请记录（可能是服务器离线时处理的申请，或在其他客户端添加）。',
    `时间：${bjText(rec.addedAt)}`
  ].join('\n');
}

/** 注入私聊唤醒提示：让模型知道好友是怎么加上的，不要乱问。长期有效。 */
export function formatFriendSourceLine(rec, now = Date.now()) {
  if (!rec) return '';
  const at = rec.addedAt ? `${bjText(rec.addedAt)} ` : '';
  if (rec.direction === 'incoming') {
    const msg = rec.comment ? `，验证消息：「${rec.comment}」` : '';
    return `【好友来源】${at ? `对方是 ${at}加上的好友：` : ''}对方申请加你${msg}。你已经知道来源，不要问“你是谁/怎么加的我”，也不用刻意复述验证消息。\n\n`;
  }
  if (rec.direction === 'outgoing') {
    const reason = rec.comment ? `（理由：「${rec.comment}」）` : '';
    return `【好友来源】${at ? `${at}加上的好友：` : ''}你是主动加对方的${reason}。不要问对方怎么加的你，也不要假装是对方加的你。\n\n`;
  }
  return `【好友来源】${at ? `${at}加上的好友：` : ''}来源未记录/不确定。不要编造来源，也不要追问“怎么加的我”。\n\n`;
}

export function formatFriendSourceReport(state, ref) {
  const s = String(ref ?? '').trim().replace(/^#/, '');
  const uin = toInt(s);
  const rec = uin > 0 ? friendRecordForUin(state, uin) : null;
  if (!rec) {
    return `没有找到${uin > 0 ? ` QQ ${uin} ` : ''}的好友来源记录。\n只记录部署后收到的申请/新增事件，历史好友无法追溯谁先加谁。`;
  }
  const who = rec.remark || rec.nickname
    ? `QQ ${rec.uin}${rec.remark ? `（备注：${rec.remark}）` : `（${rec.nickname}）`}`
    : `QQ ${rec.uin}`;
  const status = rec.status || 'added';
  const statusLabel = status === 'pending' ? '待处理' : status === 'rejected' ? '已拒绝' : '已通过';
  const direction = rec.direction === 'incoming'
    ? `对方申请加你（${statusLabel}）`
    : rec.direction === 'outgoing'
      ? '你主动加对方（你 → 对方）'
      : '不确定/未记录';
  const timeLine = rec.addedAt
    ? `添加时间：${bjText(rec.addedAt)}`
    : rec.receivedAt
      ? `申请时间：${bjText(rec.receivedAt)}`
      : '添加时间：未记录';
  return [
    `【好友来源】${who}`,
    timeLine,
    `方向：${direction}`,
    `验证消息：${rec.comment ? `「${rec.comment}」` : '（无）'}`,
    rec.requestId ? `对应申请：${rec.requestId}` : ''
  ].filter(Boolean).join('\n');
}

export const FRIEND_REQUEST_HELP = [
  '【好友申请 · 用法】',
  '机器人会实时记录好友申请，到达时私聊通知你；不会自动通过。',
  '',
  '查看待处理（序号从 1 开始）：',
  '  [好友申请]',
  '',
  '处理申请：',
  '  [通过申请 1]',
  '  [拒绝申请 1]',
  '  [通过申请 fr_ab12cd]      （也可以用 #id）',
  '',
  '查某个好友的来源：',
  '  [好友来源 12345678]',
  '',
  '手动记录来源（已有好友也能补）：',
  '  [好友来源 设置] [12345678] [对方加我] [当时在群里认识的]',
  '  [好友来源 设置] [12345678] [我加对方] [一起打游戏加的]',
  '',
  '说明：',
  '  只记录部署后收到的申请和新增好友事件；历史好友无法追溯谁先加谁。',
  '  新好友第一次聊天时，机器人会带上来源和验证消息，不会乱问“你是谁/怎么加的我”。'
].join('\n');

/** 解析 owner 的好友申请指令。 */
export function parseFriendRequestCommand(text) {
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

  if (/^(?:好友申请帮助|好友申请用法|申请帮助|申请用法)$/.test(compact)) {
    return { ok: true, action: 'help', raw };
  }
  if (/^(?:好友申请|申请列表|好友申请列表|好友请求列表)$/.test(compact)) {
    return { ok: true, action: 'list', raw };
  }
  let m = s.match(/^(?:通过|同意|接受)\s*(?:好友)?\s*申请\s*(.+)$/);
  if (m) return { ok: true, action: 'approve', ref: m[1].trim(), raw };
  m = s.match(/^(?:拒绝|驳回)\s*(?:好友)?\s*申请\s*(.+)$/);
  if (m) return { ok: true, action: 'reject', ref: m[1].trim(), raw };
  m = s.match(/^好友来源\s*(?:设置|备注|记录|标记)\s+(.+?)\s+(对方加我|对方加的|对方申请|ta加我|我加对方|我主动加的|我加的|主动加|不确定|未知)\s*([\s\S]*)$/i);
  if (m) {
    const dirText = m[2];
    const direction = /我加|我主动|主动加/.test(dirText)
      ? 'outgoing'
      : /不确定|未知/.test(dirText)
        ? 'unknown'
        : 'incoming';
    return { ok: true, action: 'annotate', target: m[1].trim(), direction, reason: m[3].trim(), raw };
  }
  m = s.match(/^(?:好友来源|来源查询)\s*(.+)$/);
  if (m) return { ok: true, action: 'source', ref: m[1].trim(), raw };
  return { ok: false };
}
