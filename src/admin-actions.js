// 管理指令：纯解析/帮助，不做 I/O。
//
// [入群申请] / [通过入群 1] / [踢人 群号 QQ 确认] / [禁言 群号 QQ 30] /
// [改名片 群号 QQ 新名片] / [撤回 -123456789] / [管理帮助]
//
// 方括号可省略；参数用空格分隔；文本类参数吃掉剩余全部内容。
// 也支持分段写法：[踢人][群名][好友名][确认]，这样群名/好友名可以带空格。

import { bracketSegments } from './command-args.js';

const KEYWORD_ACTIONS = new Map(Object.entries({
  '入群申请': 'groupRequests',
  '入群请求': 'groupRequests',
  '加群申请': 'groupRequests',
  '通过入群': 'groupRequestApprove',
  '同意入群': 'groupRequestApprove',
  '拒绝入群': 'groupRequestReject',
  '驳回入群': 'groupRequestReject',
  '踢人': 'kick',
  '禁言': 'ban',
  '解禁': 'unban',
  '解除禁言': 'unban',
  '全员禁言': 'wholeBan',
  '改名片': 'setCard',
  '改群名': 'setGroupName',
  '设管理': 'setAdmin',
  '群头衔': 'setTitle',
  '设置头衔': 'setTitle',
  '设精华': 'setEssence',
  '设置精华': 'setEssence',
  '加精': 'setEssence',
  '取消精华': 'deleteEssence',
  '移出精华': 'deleteEssence',
  '取消加精': 'deleteEssence',
  '群签到': 'groupSign',
  '退群': 'leaveGroup',
  '撤回': 'recall',
  '查qq': 'strangerInfo',
  '改备注': 'setFriendRemark',
  '删好友': 'deleteFriend',
  '管理帮助': 'help',
  '管理员帮助': 'help',
  '管理指令': 'help'
}));

const ID_RE = /^\d{5,12}$/;

function normalize(text) {
  return String(text ?? '')
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 目标字段：5~12 位数字当号码，其它当名字交给 bridge 解析。
 * 返回 { id } 或 { id: 0, text }，保持数字输入时的旧返回形状。
 */
function toTarget(value) {
  const s = String(value ?? '').trim();
  if (!s) return { id: 0 };
  if (ID_RE.test(s)) return { id: Number(s) };
  // 全数字但位数不对：当格式错误，不当群名/好友名（避免把 123 这种误解析成名字）。
  if (/^\d+$/.test(s)) return { id: 0 };
  return { id: 0, text: s };
}

function targetFields(prefix, target) {
  return target.id ? { [`${prefix}Id`]: target.id } : { [`${prefix}Text`]: target.text };
}

function hasTarget(target) {
  return target.id > 0 || !!target.text;
}

function onOff(value) {
  const s = String(value ?? '').toLowerCase();
  if (s === 'on' || s === '开' || s === '开启' || s === '启用') return true;
  if (s === 'off' || s === '关' || s === '关闭') return false;
  return null;
}

function isConfirm(value) {
  return /^确认[!！]?$/.test(String(value ?? ''));
}

function missing(action) {
  return { ok: false, error: 'missing-args', action };
}

function invalid(action, field) {
  return { ok: false, error: 'invalid-args', action, field };
}

function requestRef(action, value) {
  const ref = String(value ?? '');
  return { ok: true, action, ref, seq: /^\d+$/.test(ref) ? Number(ref) : 0 };
}

export const ADMIN_HELP = [
  '【管理指令 · 用法】',
  '  方括号可加可不加，参数用空格分隔；名称类参数写到行尾，可以带空格。',
  '  群号/QQ 号可以换成群名/好友备注：[踢人][测试群聊][示例好友甲][确认]。',
  '  名字有重名时会拒绝执行并列出候选，改用群号/QQ 号即可。',
  '',
  '入群申请',
  '  [入群申请] / [入群请求] / [加群申请]',
  '  [通过入群 1] / [同意入群 1]              按序号通过',
  '  [通过入群 fr_ab12cd]                     按 flag 通过',
  '  [拒绝入群 1] / [驳回入群 fr_ab12cd]',
  '',
  '群成员管理',
  '  [踢人 7000001 7770486 确认]        危险：必须带“确认”',
  '  [禁言 7000001 7770486 30 确认]     分钟数可省略（默认 10）；危险：必须带“确认”',
  '  [禁言 7000001 7770486 确认]        省略分钟数、直接确认（默认 10 分钟）',
  '  [解禁 7000001 7770486]',
  '  [全员禁言 7000001 on 确认]             开启必须带“确认”',
  '  [全员禁言 7000001 off]                关闭不需要确认',
  '  [改名片 7000001 7770486 新名片 可以带空格 确认]',
  '  [改群名 7000001 新的群名 可以带空格 确认]',
  '  [设管理 7000001 7770486 on 确认]    授予/取消管理员都要确认',
  '  [群头衔 7000001 7770486 头衔 确认]  头衔可带空格；危险：必须带“确认”',
  '',
  '群操作',
  '  [退群 7000001 确认]                   危险：必须带“确认”',
  '  [撤回 -123456789 确认]                   message_id 可为负数；危险：必须带“确认”',
  '  [设精华 -123456789 确认]                 设置精华消息；危险：必须带“确认”',
  '  [取消精华 -123456789 确认]               取消精华消息；危险：必须带“确认”',
  '  [群签到 7000001]                      在指定群完成群签到',
  '',
  '好友',
  '  [查QQ 7770486]',
  '  [改备注 7770486 老同学 可以带空格]',
  '  [删好友 7770486 确认]                 危险：必须带“确认”',
  '  [管理帮助] / [管理员帮助] / [管理指令]',
  '',
  '说明：主动加好友当前不支持。',
  '危险操作必须带“确认”：踢人、退群、删好友、禁言、开启全员禁言、改名片、',
  '改群名、设管理、群头衔、设精华、取消精华、撤回。没带“确认”只提示，不会执行。'
].join('\n');

/** 解析管理指令；普通聊天返回 { ok: false }，不抛异常。 */
export function parseAdminCommand(text) {
  // 分段写法：[踢人][群名][好友名][确认]；单段/无方括号仍按空格切分。
  const segments = bracketSegments(text);
  let tokens;
  if (segments) {
    tokens = segments;
  } else {
    const s = normalize(text);
    if (!s) return { ok: false };
    tokens = s.split(' ');
  }

  const action = KEYWORD_ACTIONS.get(tokens[0].replace(/[：:]$/, '').toLowerCase());
  if (!action) return { ok: false };
  const args = tokens.slice(1);

  if (action === 'help') return { ok: true, action };
  if (action === 'groupRequests') return { ok: true, action };

  if (action === 'groupRequestApprove' || action === 'groupRequestReject') {
    if (!args[0]) return missing(action);
    return requestRef(action, args[0]);
  }

  if (action === 'kick') {
    const group = toTarget(args[0]);
    const user = toTarget(args[1]);
    if (!hasTarget(group) || !hasTarget(user)) return missing(action);
    return {
      ok: true, action, ...targetFields('group', group), ...targetFields('user', user),
      confirmed: isConfirm(args[2])
    };
  }

  if (action === 'ban') {
    const group = toTarget(args[0]);
    const user = toTarget(args[1]);
    if (!hasTarget(group) || !hasTarget(user)) return missing(action);
    const minutes = /^\d+$/.test(args[2] ?? '') ? Number(args[2]) : 10;
    const confirmed = isConfirm(args[2]) || isConfirm(args[3]);
    return {
      ok: true, action, ...targetFields('group', group), ...targetFields('user', user),
      minutes, confirmed
    };
  }

  if (action === 'unban') {
    const group = toTarget(args[0]);
    const user = toTarget(args[1]);
    if (!hasTarget(group) || !hasTarget(user)) return missing(action);
    return { ok: true, action, ...targetFields('group', group), ...targetFields('user', user) };
  }

  if (action === 'wholeBan') {
    const group = toTarget(args[0]);
    if (!hasTarget(group)) return missing(action);
    const enable = onOff(args[1]);
    if (enable === null) return args[1] === undefined ? missing(action) : invalid(action, 'enable');
    return { ok: true, action, ...targetFields('group', group), enable, confirmed: isConfirm(args[2]) };
  }

  if (action === 'setCard') {
    const group = toTarget(args[0]);
    const user = toTarget(args[1]);
    const rest = args.slice(2);
    const confirmed = isConfirm(rest[rest.length - 1]);
    if (confirmed) rest.pop();
    const card = rest.join(' ').trim();
    if (!hasTarget(group) || !hasTarget(user) || !card) return missing(action);
    return {
      ok: true, action, ...targetFields('group', group), ...targetFields('user', user),
      card, confirmed
    };
  }

  if (action === 'setGroupName') {
    const group = toTarget(args[0]);
    const rest = args.slice(1);
    const confirmed = isConfirm(rest[rest.length - 1]);
    if (confirmed) rest.pop();
    const name = rest.join(' ').trim();
    if (!hasTarget(group) || !name) return missing(action);
    return { ok: true, action, ...targetFields('group', group), name, confirmed };
  }

  if (action === 'setAdmin') {
    const group = toTarget(args[0]);
    const user = toTarget(args[1]);
    if (!hasTarget(group) || !hasTarget(user)) return missing(action);
    const enable = onOff(args[2]);
    if (enable === null) return args[2] === undefined ? missing(action) : invalid(action, 'enable');
    return {
      ok: true, action, ...targetFields('group', group), ...targetFields('user', user),
      enable, confirmed: isConfirm(args[3])
    };
  }

  if (action === 'setTitle') {
    const group = toTarget(args[0]);
    const user = toTarget(args[1]);
    if (!hasTarget(group) || !hasTarget(user)) return missing(action);
    const rest = args.slice(2);
    const confirmed = isConfirm(rest[rest.length - 1]);
    if (confirmed) rest.pop();
    const title = rest.join(' ').trim();
    if (!title) return missing(action);
    return {
      ok: true, action, ...targetFields('group', group), ...targetFields('user', user),
      title, confirmed
    };
  }

  if (action === 'setEssence' || action === 'deleteEssence') {
    // message_id 是带符号的 int32，可能为负数；原样按整数解析。
    if (!/^-?\d+$/.test(args[0] ?? '')) return missing(action);
    return { ok: true, action, messageId: Number(args[0]), confirmed: isConfirm(args[1]) };
  }

  if (action === 'groupSign') {
    const group = toTarget(args[0]);
    if (!hasTarget(group)) return missing(action);
    return { ok: true, action, ...targetFields('group', group) };
  }

  if (action === 'leaveGroup') {
    const group = toTarget(args[0]);
    if (!hasTarget(group)) return missing(action);
    return { ok: true, action, ...targetFields('group', group), confirmed: isConfirm(args[1]) };
  }

  if (action === 'recall') {
    if (!/^-?\d+$/.test(args[0] ?? '')) return missing(action);
    return { ok: true, action, messageId: Number(args[0]), confirmed: isConfirm(args[1]) };
  }

  if (action === 'strangerInfo') {
    const user = toTarget(args[0]);
    if (!hasTarget(user)) return missing(action);
    return { ok: true, action, ...targetFields('user', user) };
  }

  if (action === 'setFriendRemark') {
    const user = toTarget(args[0]);
    const remark = args.slice(1).join(' ').trim();
    if (!hasTarget(user) || !remark) return missing(action);
    return { ok: true, action, ...targetFields('user', user), remark };
  }

  if (action === 'deleteFriend') {
    const user = toTarget(args[0]);
    if (!hasTarget(user)) return missing(action);
    return { ok: true, action, ...targetFields('user', user), confirmed: isConfirm(args[1]) };
  }

  return { ok: false };
}
