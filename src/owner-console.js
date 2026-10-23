// owner 控制台指令：纯解析/格式化，不做 I/O。
//
// [状态] / [会话列表] / [群列表] / [群成员 <群号>] /
// [最近错误] / [提醒列表] / [取消提醒 <id>] / [控制台帮助]
import { bracketSegments } from './command-args.js';

function bjText(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime()) || Number(ms) <= 0) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function bjShort(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime()) || Number(ms) <= 0) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${mins}分`;
  return `${mins}分`;
}

export const CONSOLE_HELP = [
  '【控制台 · 用法】',
  '  [状态]                          运行状态、额度、下次检查',
  '  [会话列表]                      各会话未读/最近活动',
  '  [群列表]                        机器人所在的群',
  '  [群成员 7000001]             群成员名单（最多 50 人）',
  '  [最近错误]                      最近的失败日志',
  '  [余额]                          查 DeepSeek 账户余额',
  '  [提醒列表]                      当前待提醒',
  '  [取消提醒 r_xxxxxxxx]           取消一条提醒',
  '',
  '只读查看：',
  '  [今日用量] / [成本]             今日 token 用量与估算花费',
  '  [服务器]                        负载、内存、磁盘、运行时长',
  '  [群信息 7000001]             群名称/人数/群主/创建时间',
  '  [群公告 7000001]             最近 5 条群公告',
  '  [标记已读 7000001]           标记群/私聊已读（自动识别）',
  '  [看转发 <forward_id>]           查看合并转发的文字内容',
  '  [查看帮助]                      本组指令的完整用法',
  '',
  '白名单管理：',
  '  [私聊白名单] / [私聊白名单管理]  查看 + 好友未加入',
  '  [私聊白名单 添加|删除|设置 ...]  增删/整体替换',
  '  [群聊白名单] / [群聊白名单管理]  查看 + 已加群未加入',
  '  [群聊白名单 添加|删除|设置 ...]',
  '  [白名单帮助]                     完整用法',
  '',
  '更多工具：',
  '  [备份状态]                       服务器/异地备份与 36h 告警',
  '  [群成员查 群号 关键词]           搜索群成员',
  '  [拍一拍 QQ] / [拍一拍 群号 QQ]   拍一拍',
  '  [清上下文 目标 确认]             清目标上下文（记忆保留）',
  '  [撤回最近 确认]                  撤回机器人最近一条',
  '  [我的名片赞] / [记忆列表]        名片赞 / 长期记忆概览',
  '  [忘记记忆 关键词 确认]           删除记忆（先预览）',
  '  [收藏列表] / [改昵称 昵称 确认]  收藏表情 / 改机器人昵称',
  '  [主动唤醒 目标] / [主动对话 目标 内容]  主动触发一次',
  '  [主动状态 目标] / [主动开关 目标 on|off] 主动问候开关（3天无对话自动暂停）',
  '  [限额调整] / [限额重置 目标]     发送限额与今日计数',
  '  [定时任务 时间 目标 内容]        到点主动执行；加 [连续7天] 限次数',
  '  [定时任务 查看所有] / [取消 序号] 查看/取消正在运行的任务',
  '  [查询模型余额 deepseek|千问|豆包] 供应商余额',
  '  [消息表情回应 消息id 表情id]      给消息加表情回应',
  '  [高级帮助]                       完整用法',
  '',
  '发 [指令] 查看全部指令。'
].join('\n');

/** 解析控制台指令。 */
export function parseOwnerConsoleCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false };

  // 分段写法：[群成员][测试群聊]（群名可以带空格）。
  const segments = bracketSegments(text);
  if (segments) {
    const head = String(segments[0] ?? '').replace(/[：:]$/, '').replace(/\s+/g, '');
    const rest = segments.slice(1).join(' ').trim();
    if (/^(?:群成员|查看群成员|群成员列表)$/.test(head)) {
      return /^\d{5,12}$/.test(rest)
        ? { ok: true, action: 'groupMembers', groupId: Number(rest) }
        : { ok: true, action: 'groupMembers', groupId: 0, groupText: rest };
    }
    if (/^(?:取消提醒|删除提醒)$/i.test(head) && /^r_[a-f0-9]{8,}$/i.test(rest)) {
      return { ok: true, action: 'cancelReminder', id: rest };
    }
  }

  const s = raw
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { ok: false };
  const compact = s.replace(/\s+/g, '');

  if (/^(?:状态|运行状态|机器人状态|status)$/i.test(compact)) return { ok: true, action: 'status' };
  if (/^(?:会话列表|会话|对话列表)$/.test(compact)) return { ok: true, action: 'conversations' };
  if (/^(?:群列表|群聊列表|我的群)$/.test(compact)) return { ok: true, action: 'groups' };
  if (/^(?:控制台帮助|控制台|机器人帮助)$/.test(compact)) return { ok: true, action: 'help' };
  if (/^(?:最近错误|错误|错误日志|最近异常)$/.test(compact)) return { ok: true, action: 'errors' };
  if (/^(?:余额|deepseek余额|查询余额|查询deepseek余额|ds余额)$/i.test(compact)) return { ok: true, action: 'deepseekBalance' };
  if (/^(?:提醒列表|提醒|定时提醒|我的提醒)$/.test(compact)) return { ok: true, action: 'reminders' };

  let m = s.match(/^(?:群成员|查看群成员|群成员列表)\s*(\d{5,12})?$/);
  if (m) return { ok: true, action: 'groupMembers', groupId: Number(m[1]) || 0 };

  m = s.match(/^(?:取消提醒|删除提醒)\s*(r_[a-f0-9]{8,})$/i);
  if (m) return { ok: true, action: 'cancelReminder', id: m[1] };

  return { ok: false };
}

export function formatStatus(d = {}) {
  const lines = ['【机器人状态】'];
  lines.push(`模式：${d.mode || 'unknown'}｜运行：${fmtDuration(d.uptimeMs)}`);
  if (d.selfUin) {
    const online = d.accountOnline === true ? '｜在线' : d.accountOnline === false ? '｜离线' : '';
    lines.push(`账号：${d.selfNickname || '机器人'}(${d.selfUin})${online}`);
  }
  const qz = d.qzone || {};
  lines.push(`空间：${qz.enabled ? '开启' : '关闭'}｜自动发${qz.autoPublish ? '开启' : '关闭'}${qz.nextAutoCheckAt ? `｜下次 ${bjText(qz.nextAutoCheckAt)}` : ''}`);
  lines.push(`今日额度：发帖 ${qz.postToday ?? 0}/${qz.postMax ?? '不限'}｜配图 ${qz.imageToday ?? 0}/${qz.imageMax ?? '不限'}｜赞 ${d.social?.likeToday ?? 0}/${d.social?.likeMax ?? '不限'}｜评 ${d.social?.commentToday ?? 0}/${d.social?.commentMax ?? '不限'}｜追评 ${d.social?.followupToday ?? 0}/${d.social?.followupMax ?? '不限'}`);
  const sc = d.social || {};
  lines.push(`好友互动：${sc.enabled ? '开启' : '关闭'}${sc.nextCheckAt ? `｜下次 ${bjText(sc.nextCheckAt)}` : ''}`);
  lines.push(`待处理评论：${d.pendingComments ?? 0} 条｜会话：${d.conversations ?? 0} 个｜提醒：${d.reminders ?? 0} 条`);
  return lines.join('\n');
}

export function formatConversations(rows) {
  if (!Array.isArray(rows) || !rows.length) return '当前没有会话。';
  const lines = [`【会话列表】${rows.length} 个`];
  rows.forEach((r, i) => {
    const kind = String(r.key || '').startsWith('group:') ? '群' : '私聊';
    lines.push(`${i + 1}. ${r.key}（${kind}）未读 ${r.unread ?? 0}｜最近 ${r.recent ?? 0}${r.lastIncomingAt ? `｜最后来信 ${bjShort(r.lastIncomingAt)}` : ''}${r.lastAiReplyAt ? `｜上次回复 ${bjShort(r.lastAiReplyAt)}` : ''}`);
  });
  return lines.join('\n');
}

export function formatGroups(groups) {
  const rows = (Array.isArray(groups) ? groups : [])
    .map((g) => ({
      id: Math.max(0, Number(g?.group_id ?? g?.groupId ?? g?.id) || 0),
      name: String(g?.group_name ?? g?.groupName ?? g?.name ?? '').trim(),
      count: Math.max(0, Number(g?.member_count ?? g?.memberCount) || 0)
    }))
    .filter((g) => g.id > 0);
  if (!rows.length) return '没有获取到群列表。';
  return [`【群列表】${rows.length} 个`, ...rows.map((g, i) => `${i + 1}. ${g.name || '未命名'}(${g.id})${g.count ? `  ${g.count} 人` : ''}`)].join('\n');
}

export function formatGroupMembers(groupId, members) {
  const rows = (Array.isArray(members) ? members : [])
    .map((m) => ({
      uin: Math.max(0, Number(m?.user_id ?? m?.uin) || 0),
      name: String(m?.card || m?.nickname || '').trim()
    }))
    .filter((m) => m.uin > 0);
  if (!rows.length) return `群 ${groupId || ''} 没有成员数据。`;
  const shown = rows.slice(0, 50);
  const lines = [`【群成员】${groupId}｜${rows.length} 人`, ...shown.map((m, i) => `${i + 1}. ${m.name || '未命名'}(${m.uin})`)];
  if (rows.length > shown.length) lines.push(`…只显示前 ${shown.length} 人`);
  return lines.join('\n');
}

export function formatRecentErrors(rows) {
  if (!Array.isArray(rows) || !rows.length) return '最近没有错误日志。';
  return ['【最近错误】', ...rows.map((r, i) => {
    const at = r.at ? `${bjShort(r.at)} ` : '';
    const label = r.label ? `[${r.label}] ` : '';
    return `${i + 1}. ${at}${label}${String(r.text || '').slice(0, 140)}`;
  })].join('\n');
}

export function formatDeepSeekBalance(data) {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  if (!infos.length) return 'DeepSeek 余额查询成功，但没有返回余额信息。';
  const lines = [`【DeepSeek 余额】${data?.is_available === false ? '不可用' : '可用'}`];
  for (const b of infos) {
    const symbol = String(b?.currency || 'CNY').toUpperCase() === 'USD' ? '$' : '¥';
    lines.push(`${b?.currency || 'CNY'}：总余额 ${symbol}${b?.total_balance ?? '?'}（充值 ${symbol}${b?.topped_up_balance ?? '?'} / 赠送 ${symbol}${b?.granted_balance ?? '?'}）`);
  }
  return lines.join('\n');
}

export function formatReminders(rows) {
  if (!Array.isArray(rows) || !rows.length) return '当前没有待提醒。';
  const lines = [`【提醒列表】${rows.length} 条`];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.id}｜${bjText(r.at)}｜${r.key}${r.repeat ? `｜${r.repeat}` : ''}`);
    lines.push(`   ${String(r.text || '').slice(0, 100)}`);
  });
  return lines.join('\n');
}
