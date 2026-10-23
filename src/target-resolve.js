// 目标名匹配：把「群名/好友备注/群名片」解析成群号/QQ 号。
// 纯函数，不做 I/O；取 get_group_list / get_friend_list / get_group_member_list 在 bridge 里。
//
// 规则（对所有目标一致）：
// 1. 5~12 位纯数字直接当群号/QQ 号，不做名字匹配。
// 2. 先精确匹配（大小写、空白归一），再子串匹配。
// 3. 命中多个 → 返回 ambiguous + 候选，绝不猜；调用方提示管理员改用号码。
// 4. 一个都没命中 → not-found。

const ID_RE = /^\d{5,12}$/;

export function isTargetId(value) {
  return ID_RE.test(String(value ?? '').trim());
}

function norm(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function pickOne(matches, { limit = 5 } = {}) {
  // 按 id 去重：同一个群/好友可能在多个字段上命中同一个名字。
  const seen = new Set();
  const unique = [];
  for (const item of matches) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  if (unique.length === 1) return { ok: true, id: unique[0].id, name: unique[0].name, item: unique[0] };
  if (!unique.length) return { ok: false, reason: 'not-found' };
  return {
    ok: false,
    reason: 'ambiguous',
    candidates: unique.slice(0, limit),
    total: unique.length
  };
}

function nameMatches(fields, query) {
  const q = norm(query);
  if (!q) return { exact: false, partial: false };
  let exact = false;
  let partial = false;
  for (const raw of fields) {
    const n = norm(raw);
    if (!n) continue;
    if (n === q) exact = true;
    else if (n.includes(q)) partial = true;
  }
  return { exact, partial };
}

/**
 * 群名匹配。
 * groups: [{group_id, group_name}]
 * @returns {{ok:true,id:string,name:string,item:object}|{ok:false,reason:string,candidates?:Array,total?:number}}
 */
export function matchGroup(groups, query, opts = {}) {
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g && typeof g === 'object');
  const exact = [];
  const partial = [];
  for (const g of list) {
    const id = String(g.group_id ?? g.groupId ?? '').trim();
    const name = String(g.group_name ?? g.groupName ?? g.name ?? '').trim();
    if (!id || !name) continue;
    const hit = nameMatches([name], query);
    if (hit.exact) exact.push({ id, name, item: g });
    else if (hit.partial) partial.push({ id, name, item: g });
  }
  return pickOne(exact.length ? exact : partial, opts);
}

/**
 * 好友匹配。备注优先于昵称，但两者都参与精确/子串匹配。
 * friends: [{user_id, remark, nickname}]
 */
export function matchFriend(friends, query, opts = {}) {
  const list = (Array.isArray(friends) ? friends : []).filter((f) => f && typeof f === 'object');
  const exact = [];
  const partial = [];
  for (const f of list) {
    const id = String(f.user_id ?? f.uin ?? f.userId ?? '').trim();
    if (!id) continue;
    const remark = String(f.remark ?? '').trim();
    const nickname = String(f.nickname ?? f.nick ?? '').trim();
    const name = remark || nickname || id;
    const hit = nameMatches([remark, nickname], query);
    if (hit.exact) exact.push({ id, name, item: f });
    else if (hit.partial) partial.push({ id, name, item: f });
  }
  // 数字查询按 QQ 号包含匹配兜底（例如只记得后几位）。
  if (!exact.length && !partial.length && /^\d+$/.test(String(query ?? '').trim())) {
    const q = String(query).trim();
    for (const f of list) {
      const id = String(f.user_id ?? f.uin ?? f.userId ?? '').trim();
      if (id && id.includes(q)) {
        const remark = String(f.remark ?? '').trim();
        const nickname = String(f.nickname ?? f.nick ?? '').trim();
        partial.push({ id, name: remark || nickname || id, item: f });
      }
    }
  }
  return pickOne(exact.length ? exact : partial, opts);
}

/**
 * 群成员匹配（按 QQ/群名片/昵称/头衔）。
 * members: [{user_id, card, nickname, title}]
 */
export function matchGroupMember(members, query, opts = {}) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === 'object');
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, reason: 'not-found' };

  const exact = [];
  const partial = [];
  for (const m of list) {
    const id = String(m.user_id ?? m.uin ?? '').trim();
    if (!id) continue;
    const card = String(m.card ?? '').trim();
    const nickname = String(m.nickname ?? m.nick ?? '').trim();
    const title = String(m.title ?? '').trim();
    const name = card || nickname || title || id;

    if (/^\d+$/.test(q)) {
      if (id === q) exact.push({ id, name, item: m });
      else if (id.includes(q)) partial.push({ id, name, item: m });
      continue;
    }

    const hit = nameMatches([card, nickname, title], q);
    if (hit.exact) exact.push({ id, name, item: m });
    else if (hit.partial) partial.push({ id, name, item: m });
  }
  return pickOne(exact.length ? exact : partial, opts);
}

/** 把匹配失败结果转成给管理员看的提示。kind: group|friend|member */
export function formatMatchFailure(result, query, kind = 'group') {
  const label = kind === 'group' ? '群' : (kind === 'member' ? '群成员' : '好友');
  const q = String(query ?? '').trim();
  if (result?.reason === 'ambiguous') {
    const lines = [`有 ${result.total ?? result.candidates.length} 个${label}匹配「${q}」，不能确定是哪一个：`];
    result.candidates.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c.name}（${c.id}）`);
    });
    lines.push(kind === 'group'
      ? '请改用群号，或把群名写得更完整。'
      : (kind === 'member' ? '请改用 QQ 号。' : '请改用 QQ 号。'));
    return lines.join('\n');
  }
  if (kind === 'group') {
    return `没找到群「${q}」。发 [群列表] 看看机器人加了哪些群，或直接用群号。`;
  }
  if (kind === 'member') {
    return `没找到群成员「${q}」。可以发 [群成员 群号] 看名单，或直接用 QQ 号。`;
  }
  return `没找到好友「${q}」。发 [查看你全部好友] 看看备注，或直接用 QQ 号。`;
}
