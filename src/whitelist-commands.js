// 白名单管理指令：纯解析/格式化，不做 I/O。
//
// 命令：
//   [私聊白名单] / [私聊白名单管理]              查看私聊白名单 + 好友未加入
//   [私聊白名单 添加 123456] / [删除 123456]    增删
//   [私聊白名单 设置 123,456]                   整体替换
//   [群聊白名单] / [群聊白名单管理]              查看群白名单 + 已加群未加入
//   [群聊白名单 添加 7000001] / [删除 ...]
//   [白名单] / [白名单帮助]
//
// 白名单只允许 5~12 位数字（QQ 号/群号）。真正的写配置与热更新在 bridge.js。

const ID_RE = /^\d{5,12}$/;

function normalize(text) {
  return String(text ?? '')
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function kindOf(token) {
  if (token === '私聊白名单') return 'private';
  if (token === '群聊白名单') return 'groups';
  return 'all';
}

/** 去掉命令末尾的“确认”，返回 { text, confirmed }。 */
function splitConfirm(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/(?:^|\s)(确认[!！]?)\s*$/);
  if (!m) return { text: s, confirmed: false };
  return { text: s.slice(0, m.index).trim(), confirmed: true };
}

function parseIds(raw) {
  const tokens = String(raw ?? '')
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = [];
  const invalid = [];
  for (const token of tokens) {
    if (ID_RE.test(token)) {
      const n = Number(token);
      if (!ids.includes(n)) ids.push(n);
    } else {
      invalid.push(token);
    }
  }
  return { ids, invalid };
}

const ACTION_WORDS = [
  ['list', /^(?:列表|查看|list)$/i],
  ['help', /^(?:帮助|help)$/i],
  ['add', /^(?:添加|加|新增|加入|add)$/i],
  ['remove', /^(?:删除|删|移除|remove|del)$/i],
  ['set', /^(?:设置|设为|替换|修改|set)$/i],
  ['clear', /^(?:清空|clear)$/i]
];

function actionOf(word) {
  for (const [action, re] of ACTION_WORDS) {
    if (re.test(word)) return action;
  }
  return '';
}

/**
 * 解析白名单指令。
 * @returns {{ok:false}|{ok:true, action:string, kind:'private'|'groups'|'all', ids:number[], invalid:string[], raw:string}}
 */
export function parseWhitelistCommand(text) {
  const s = normalize(text);
  if (!s) return { ok: false };

  // 帮助：白名单帮助 / 私聊白名单帮助 / 群聊白名单管理帮助
  let m = s.match(/^(私聊白名单|群聊白名单|白名单)(?:管理)?帮助$/);
  if (m) return { ok: true, action: 'help', kind: kindOf(m[1]), ids: [], invalid: [], raw: s };

  m = s.match(/^(私聊白名单|群聊白名单|白名单)(?:管理|列表|查看)?(?:\s+(.*))?$/);
  if (!m) return { ok: false };
  const kind = kindOf(m[1]);
  const rest = String(m[2] ?? '').trim();
  if (!rest) return { ok: true, action: 'list', kind, ids: [], invalid: [], raw: s };

  const split = splitConfirm(rest);
  const tokens = split.text.split(' ');
  const action = actionOf(tokens[0]);
  if (!action) {
    const out = { ok: true, action: 'unknown', kind, ids: [], invalid: [], raw: rest };
    if (split.confirmed) out.confirmed = true;
    return out;
  }
  if (action === 'list' || action === 'help') {
    return { ok: true, action, kind, ids: [], invalid: [], raw: rest };
  }
  if (action === 'clear') {
    const out = { ok: true, action: 'set', kind, ids: [], invalid: [], raw: rest };
    if (split.confirmed) out.confirmed = true;
    return out;
  }
  const { ids, invalid } = parseIds(tokens.slice(1).join(' '));
  const out = { ok: true, action, kind, ids, invalid, raw: rest };
  if (split.confirmed) out.confirmed = true;
  return out;
}

export const WHITELIST_HELP = [
  '【白名单管理】',
  '  方括号可省略，QQ 号/群号写 5~12 位数字；逗号或空格分隔多个。',
  '',
  '私聊',
  '  [私聊白名单] / [私聊白名单管理]        查看白名单 + 好友中未加入的人',
  '  [私聊白名单 添加 123456]              加入一个/多个',
  '  [私聊白名单 删除 123456]              移除一个/多个',
  '  [私聊白名单 设置 123,456 确认]         整体替换（管理员 QQ 始终保留；必须确认）',
  '  [私聊白名单 清空 确认]                 清空（管理员 QQ 始终保留；必须确认）',
  '',
  '群聊',
  '  [群聊白名单] / [群聊白名单管理]        查看白名单 + 已在群里但未加入的群',
  '  [群聊白名单 添加 7000001]',
  '  [群聊白名单 删除 7000001]',
  '  [群聊白名单 设置 7000001,123456 确认]',
  '  [群聊白名单 清空 确认]',
  '  [白名单帮助]                          本页',
  '',
  '说明：',
  '  • 不在白名单的私聊/群聊，机器人不会回复。',
  '  • 管理员 QQ 不能被移出私聊白名单，避免把自己锁在外面。',
  '  • 新好友通过申请后默认加入私聊白名单（config: autoWhitelistNewFriends）。',
  '发 [指令] 查看全部指令。'
].join('\n');

function labelOf(id, labels) {
  const name = String(labels?.[String(id)] ?? labels?.[id] ?? '').trim();
  return name ? `${name}(${id})` : String(id);
}

function numbered(ids, labels, limit) {
  const shown = ids.slice(0, limit);
  const lines = shown.map((id, i) => `${i + 1}. ${labelOf(id, labels)}`);
  if (ids.length > shown.length) lines.push(`…还有 ${ids.length - shown.length} 个`);
  return lines;
}

/**
 * 格式化白名单列表。
 * @param {object} args
 * @param {'private'|'groups'|'all'} args.kind
 * @param {number[]} args.ids
 * @param {number} [args.ownerQQ]
 * @param {Record<string,string>} [args.labels] id → 昵称/群名
 * @param {Array<{id:number,label?:string}>} [args.candidates] 未加入白名单的好友/群
 * @param {number} [args.limit]
 */
export function formatWhitelistList({ kind, ids = [], privateIds = null, groupIds = null, ownerQQ = 0, labels = {}, candidates = [], limit = 50 } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((n) => n > 0))]
    .sort((a, b) => a - b);
  const cap = Math.max(1, Math.min(100, Number(limit) || 50));

  if (kind === 'all') {
    const priv = Array.isArray(privateIds) ? privateIds : list;
    const grp = Array.isArray(groupIds) ? groupIds : [];
    return [
      `【白名单】私聊 ${priv.length} 个｜群聊 ${grp.length} 个`,
      '发 [私聊白名单] 或 [群聊白名单] 查看明细和未加入列表。'
    ].join('\n');
  }

  const isPrivate = kind === 'private';
  const title = isPrivate ? '私聊白名单' : '群聊白名单';
  const lines = [`【${title}】${list.length} 个`];
  lines.push(...numbered(list, labels, cap));
  if (!list.length) lines.push(isPrivate ? '（空，机器人不会回复任何私聊）' : '（空，机器人不会回复任何群聊）');

  if (isPrivate && ownerQQ > 0 && !list.includes(Number(ownerQQ))) {
    lines.push(`⚠️ 管理员 ${ownerQQ} 不在白名单，建议发 [私聊白名单 添加 ${ownerQQ}]。`);
  }

  const pending = (Array.isArray(candidates) ? candidates : [])
    .map((x) => ({ id: Number(x?.id) || 0, label: String(x?.label ?? '') }))
    .filter((x) => x.id > 0 && !list.includes(x.id));
  if (pending.length) {
    lines.push('', isPrivate ? `【好友未加入】${pending.length} 个` : `【已在群里但未加入】${pending.length} 个`);
    const shown = pending.slice(0, cap);
    shown.forEach((x, i) => {
      const name = x.label ? `${x.label}(${x.id})` : String(x.id);
      lines.push(`${i + 1}. ${name}`);
    });
    if (pending.length > shown.length) lines.push(`…还有 ${pending.length - shown.length} 个`);
    const example = shown[0]?.id;
    if (example) lines.push(`发 [${title} 添加 ${example}] 加入。`);
  }
  return lines.join('\n');
}

/**
 * 格式化增删结果。
 * @param {object} args
 * @param {'private'|'groups'} args.kind
 * @param {'add'|'remove'|'set'} args.action
 * @param {number[]} [args.changed]
 * @param {number[]} [args.skipped]
 * @param {number} [args.total]
 */
export function formatWhitelistChange({ kind, action, changed = [], skipped = [], total = 0 } = {}) {
  const title = kind === 'private' ? '私聊白名单' : '群聊白名单';
  const verb = action === 'add' ? '已添加' : action === 'remove' ? '已移除' : '已设置';
  const lines = [`【${title}】${verb} ${changed.length} 个`];
  if (changed.length) lines.push(changed.join('、'));
  if (skipped.length) {
    const why = action === 'add' ? '已在白名单，跳过' : action === 'remove' ? '不在白名单，跳过' : '未变化';
    lines.push(`${why}：${skipped.join('、')}`);
  }
  lines.push(`当前 ${total} 个。`);
  return lines.join('\n');
}
