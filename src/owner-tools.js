// 管理员便捷指令：独立解析、有限持久化和业务执行；不依赖聊天模型解析权限。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bracketSegments, stripOuterBrackets } from './command-args.js';
import { parseChineseTime, parseScheduledTime } from './time-parse.js';

const KEY = /^(group|private):[1-9]\d{0,11}$/;
const MSG_ID = /^-?[1-9]\d*$/;
const BAD_NAMES = new Set(['__proto__', 'prototype', 'constructor', '我', '自己', '本群', '当前', '全部', '所有']);
const COMMANDS = new Set([
  '便捷帮助', '撤回此条', '回应', '取消回应', '提醒我',
  '任务改期', '任务内容', '暂停任务', '恢复任务', '任务顺延', '任务延期',
  '免打扰', '取消免打扰', '诊断', '会话诊断',
  '别名设置', '别名列表', '别名删除', '记一下', '待办', '完成待办', '恢复待办', '删除待办',
  '搜消息', '群摘要', '更正记忆', '少聊话题', '恢复话题', '话题偏好'
]);
export const OWNER_TOOLS_HELP = [
  '【便捷工具】管理员私聊为主；群内指令也响应，详细结果私聊。',
  '引用消息后：[撤回此条 确认] / [回应 👍] / [提醒我 30分钟后]',
  '私聊操作群消息：[回应][群名或别名][消息ID][👍]',
  '撤回同上：[撤回此条][目标][消息ID][确认]；只处理该会话消息。',
  '[提醒我][明天9点][要提醒的内容]（个人提醒直接发你，不依赖AI）',
  '[任务改期][r_xxx][明天9点] / [任务内容][r_xxx][新内容]',
  '[暂停任务][r_xxx] / [恢复任务][r_xxx] / [任务顺延][r_xxx][30分钟]',
  '改期保留原周期；写“每天9点”会改周期。顺延只改本次，暂停不消耗次数。',
  '[免打扰][目标][2小时] / [取消免打扰][目标]（只停自动问候/饭点）',
  '[诊断][目标] / [别名设置][小群][群名] / [别名列表] / [别名删除][小群][确认]',
  '[记一下][周五交报告] / [待办] / [待办][全部] / [完成待办][n_xxx]',
  '[恢复待办][n_xxx] / [删除待办][n_xxx][确认]；列表最多20条，可加页码。',
  '[搜消息][目标][关键词][最近100条] / [群摘要][群名][最近100条]',
  '历史范围10~200条，摘要按需调用模型，搜索返回原消息ID供私聊操作。',
  '[更正记忆][目标][旧内容][新内容] → 预览 → 相同指令加[确认]',
  '[少聊话题][目标][宠物] / [恢复话题][目标][宠物] / [话题偏好][目标]',
  '已有任务与个人提醒均可在 [定时任务][查看所有] 中查看并按ID管理。'
].join('\n');

export function parseOwnerToolsCommand(text) {
  const segments = bracketSegments(text);
  let parts;
  if (segments) {
    const head = segments[0].trim().split(/\s+/);
    parts = [...head, ...segments.slice(1)];
  } else {
    parts = stripOuterBrackets(text).trim().split(/\s+/);
  }
  const command = parts.shift();
  if (!COMMANDS.has(command)) return null;
  const confirmMin = { 撤回此条: 1, 别名设置: 3, 别名删除: 2, 删除待办: 2, 更正记忆: 4 }[command];
  const confirmed = !!confirmMin && parts.length >= confirmMin && parts.at(-1) === '确认';
  if (confirmed) parts.pop();
  return { command, args: parts, confirmed };
}

export function validAlias(name) {
  return typeof name === 'string' && /^[\p{L}\p{N}_-]{1,20}$/u.test(name)
    && !/^\d+$/.test(name) && !BAD_NAMES.has(name) && !COMMANDS.has(name);
}

/** 单次延期/暂停不改变后续原始周期。编辑规则时调用方显式重置 anchor。 */
export function editOwnerReminder(reminder, command, value, now = Date.now()) {
  if (!reminder || !['ownerTask', 'ownerMemo'].includes(reminder.kind)) throw new Error('不是管理员任务或个人提醒');
  const next = { ...reminder };
  if (command === '暂停任务') {
    if (next.paused) throw new Error('任务已经暂停');
    next.paused = true;
    next.pauseRemainingMs = Math.max(1000, Number(next.at) - now);
  } else if (command === '恢复任务') {
    if (!next.paused) throw new Error('任务没有暂停');
    next.paused = false;
    if (next.at <= now) {
      if (next.repeat && !next.recurrenceAnchorAt) next.recurrenceAnchorAt = next.at;
      next.at = now + Math.max(1000, Number(next.pauseRemainingMs) || 1000);
    }
    next.pauseRemainingMs = 0;
  } else if (command === '任务内容') {
    const text = String(value ?? '').trim();
    if (!text || text.length > 500) throw new Error('内容须为1~500字符');
    next.text = text;
  } else {
    let at;
    if (command === '任务顺延' || command === '任务延期') {
      const duration = parseChineseTime(/后$/.test(value) ? value : `${value}后`, now);
      if (!duration.ok || !/^(?:半|[零〇一二两三四五六七八九十\d]+)(?:分钟|小时|天|周)(?:后)?$/.test(value)) {
        throw new Error('顺延请写30分钟、2小时或1天');
      }
      const delta = duration.at - now;
      at = Math.max(now, next.at) + delta;
      if (next.repeat && !next.recurrenceAnchorAt) next.recurrenceAnchorAt = next.at;
    } else {
      const parsed = parseScheduledTime(value, now);
      if (!parsed.ok) throw new Error(parsed.error || '没看懂时间');
      at = parsed.at;
      if (parsed.repeat) {
        next.repeat = parsed.repeat;
        next.recurrenceAnchorAt = at;
        next.ruleText = parsed.text;
      } else if (next.repeat) {
        // 只改本次日期时保留原周期时刻；显式“每天9点”才重设后续规则。
        if (!next.recurrenceAnchorAt) next.recurrenceAnchorAt = next.at;
      } else {
        next.recurrenceAnchorAt = null;
        next.ruleText = parsed.text;
      }
    }
    if (!Number.isSafeInteger(at) || at <= now) throw new Error('执行时间必须在未来');
    next.at = at;
    if (next.paused) next.pauseRemainingMs = at - now;
  }
  if (!next.paused && Number(next.endAt) > 0 && next.at > next.endAt) throw new Error('执行时间超过原截止日期；未修改任务');
  return next;
}

export function memoryCorrectionMatches(st, query) {
  const matches = [];
  for (const [name, item] of Object.entries(st.memberImpressions || {})) {
    const values = Array.isArray(item?.traits) ? item.traits : [];
    for (let index = 0; index < values.length; index++) {
      if (String(values[index]).includes(query)) matches.push({ category: 'memberImpression', ref: name, field: 'traits', index, old: String(values[index]) });
    }
  }
  for (const [list, category] of [['activeTopics', 'activeTopic'], ['pendingThoughts', 'pendingThought']]) {
    for (let index = 0; index < (st[list] || []).length; index++) {
      const item = st[list][index];
      for (const field of ['text', 'pendingQuestion', 'motivation']) {
        if (typeof item?.[field] === 'string' && item[field].includes(query)) {
          matches.push({ category, list, index, field, ref: String(item.text || ''), old: item[field] });
        }
      }
    }
  }
  return matches;
}

export function applyMemoryCorrection(st, match, query, replacement) {
  const copy = { ...st };
  const text = match.old.replaceAll(query, replacement);
  if (text.length > 200) throw new Error('更正后单条记忆超过200字符');
  let item;
  let ref;
  if (match.category === 'memberImpression') {
    item = { ...st.memberImpressions[match.ref], traits: [...st.memberImpressions[match.ref].traits] };
    item.traits[match.index] = text;
    copy.memberImpressions = { ...st.memberImpressions, [match.ref]: item };
    ref = match.ref;
  } else {
    copy[match.list] = [...st[match.list]];
    item = { ...st[match.list][match.index], [match.field]: text };
    if (match.field === 'text' && st[match.list].some((value, i) => i !== match.index && value?.text === text)) {
      throw new Error('更正后与已有记忆重名，请换更具体内容');
    }
    copy[match.list][match.index] = item;
    ref = String(item.text || '');
  }
  return { state: copy, item, ref, text };
}

/** 保存前备份；备份失败不写。每个文件最多留20份本模块备份。 */
export function backupOwnerFile(file) {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.bak-owner-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backup, 0o600); } catch { /* Windows ACL由桥接统一处理 */ }
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-owner-`;
  const older = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort().slice(0, -20);
  for (const name of older) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* 旧备份清理失败不影响新备份 */ } }
}

export function createOwnerTools(d) {
  const now = d.now || Date.now;
  const file = path.join(d.stateDir, 'owner-tools.json');
  const previews = new Map();
  let summaryBusy = false;
  let summaryAt = 0;
  // 每次读最新文件；损坏必须显式报错，不能把空默认值写回覆盖。
  function readStore() {
    if (!fs.existsSync(file)) return { version: 1, owners: {} };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.version !== 1 || !raw.owners || typeof raw.owners !== 'object' || Array.isArray(raw.owners)) throw new Error('便捷工具状态格式错误，已停止写入');
    return raw;
  }
  function readOwner(store = readStore()) {
    const owner = store.owners[String(d.ownerQQ())] || { aliases: [], notes: [] };
    if (!Array.isArray(owner.aliases) || !Array.isArray(owner.notes)) throw new Error('管理员存储格式错误，已停止写入');
    return owner;
  }
  function changeStore(fn) {
    const store = readStore();
    const owner = readOwner(store);
    fn(owner);
    store.owners[String(d.ownerQQ())] = owner;
    backupOwnerFile(file);
    d.atomicWrite(file, store);
  }
  function aliasTarget(name) {
    if (!validAlias(name)) return null;
    const item = readOwner().aliases.find((entry) => entry.name === name);
    return item && KEY.test(item.key) ? { key: item.key, name: item.label || name } : null;
  }
  async function target(text, sourceKey) {
    const raw = String(text || '').trim();
    const key = ['我', '自己'].includes(raw) ? `private:${d.ownerQQ()}`
      : ['本群', '当前'].includes(raw) ? sourceKey : '';
    const found = key ? { ok: true, key, kind: key.split(':')[0], targetId: Number(key.split(':')[1]), name: raw } : await d.resolveTarget(raw);
    if (!found?.ok) throw new Error(found?.message || '找不到目标');
    if (!KEY.test(found.key) || !d.isAllowed(found.key)) throw new Error('目标不在当前模式允许范围/白名单内');
    return found;
  }
  async function request(action, params) {
    const result = await d.request(action, params);
    if (result?.status !== 'ok' || Number(result.retcode) !== 0) throw new Error(`QQ接口未成功：${result?.wording || result?.status || '未知错误'}`);
    return result.data;
  }
  function taskById(id) {
    if (!/^r_[a-f0-9]{8,}$/i.test(String(id || ''))) throw new Error('请使用列表中的完整 r_xxx ID，避免序号变化');
    for (const [key, list] of d.reminders()) {
      const index = list.findIndex((item) => item.id === id && ['ownerTask', 'ownerMemo'].includes(item.kind));
      if (index >= 0) return { key, list, index, item: list[index] };
    }
    throw new Error('没找到管理员任务；发 [定时任务][查看所有] 查看');
  }
  function timeText(at) { return d.timeText(at); }
  async function checkedMessage(key, messageId) {
    if (!MSG_ID.test(String(messageId)) || !Number.isSafeInteger(Number(messageId))) throw new Error('消息ID必须是安全范围内的非零整数');
    const msg = await d.getMessage(Number(messageId));
    const [kind, id] = key.split(':');
    const messageKind = msg?.message_type || (msg?.group_id ? 'group' : 'private');
    const belongs = kind === 'group'
      ? messageKind === 'group' && String(msg?.group_id) === id
      : messageKind === 'private' && [msg?.user_id, msg?.target_id, msg?.peer_id, msg?.sender?.user_id].filter(Boolean).map(String).includes(id);
    if (!belongs) throw new Error('引用/消息ID不属于指定会话，已拒绝操作');
    return msg;
  }
  function messageText(msg) {
    if (Array.isArray(msg?.message)) return msg.message.map((seg) => seg.type === 'text' ? String(seg.data?.text || '') : seg.type === 'image' ? '[图片]' : '').join('');
    return String(msg?.raw_message || msg?.message || '');
  }
  async function history(t, count) {
    const data = await request(t.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', {
      [t.kind === 'group' ? 'group_id' : 'user_id']: t.targetId, message_id: 0, count
    });
    const list = Array.isArray(data) ? data : data?.messages;
    if (!Array.isArray(list)) throw new Error('历史接口未返回消息列表');
    return list.slice(-count).map((msg) => ({
      id: msg.message_id ?? msg.real_id ?? '',
      time: Number(msg.time || 0) * 1000,
      sender: d.redact(String(msg.sender?.card || msg.sender?.nickname || msg.sender?.user_id || msg.user_id || '未知')).replace(/\s+/g, ' ').slice(0, 60),
      text: d.redact(messageText(msg)).slice(0, 1200)
    })).sort((a, b) => a.time - b.time);
  }
  function countArg(value) {
    if (!value) return 100;
    const match = /^(?:最近)?(\d+)(?:条)?$/.exec(value);
    if (!match || Number(match[1]) < 10 || Number(match[1]) > 200) throw new Error('读取范围请写最近10条~最近200条');
    return Number(match[1]);
  }
  function requireArgs(args, min, max = min) {
    if (args.length < min || args.length > max) throw new Error('参数不完整或过多；发 [便捷帮助] 查看分段写法');
  }

  async function handle(ctx, text) {
    const cmd = parseOwnerToolsCommand(text);
    if (!cmd) return false;
    if (String(ctx.userId) !== String(d.ownerQQ())) return false;
    const { command: c, args: a, confirmed } = cmd;
    const respond = (message) => d.send(ctx.replyKey, message);
    try {
      if (c === '便捷帮助') { await respond(OWNER_TOOLS_HELP); return true; }
      if (['撤回此条', '回应', '取消回应'].includes(c)) {
        let t;
        let messageId;
        let emoji;
        if (ctx.quotedId && a.length <= 1) {
          t = await target('当前', ctx.sourceKey);
          messageId = ctx.quotedId;
          emoji = a[0];
        } else {
          requireArgs(a, c === '撤回此条' ? 2 : 3);
          t = await target(a[0], ctx.sourceKey);
          messageId = a[1]; emoji = a[2];
        }
        await checkedMessage(t.key, messageId);
        if (c === '撤回此条') {
          if (!confirmed) { await respond('撤回需确认：保留引用发送 [撤回此条 确认]；或 [撤回此条][目标][消息ID][确认]。'); return true; }
          await request('delete_msg', { message_id: Number(messageId) });
          await respond(`已撤回 ${t.name || t.key} 的消息 ${messageId}。`);
        } else {
          const emojiId = { '👍': '76', '赞': '76', '❤️': '66', '❤': '66', '😂': '182' }[emoji] || emoji;
          if (!/^\d{1,8}$/.test(String(emojiId || ''))) throw new Error('支持👍、❤️、😂或表情数字ID');
          await request('set_msg_emoji_like', { message_id: Number(messageId), emoji_id: emojiId, set: c === '回应' });
          await respond(`已${c === '回应' ? '添加' : '取消'}消息 ${messageId} 的表情回应。`);
        }
      } else if (c === '提醒我') {
        requireArgs(a, 1, 20);
        const parsed = parseChineseTime(a[0], now());
        if (!parsed.ok || parsed.at <= now()) throw new Error(parsed.error || '提醒时间须在未来');
        let content = a.slice(1).join(' ');
        if (!content && ctx.quotedId) {
          const msg = await checkedMessage(ctx.sourceKey, ctx.quotedId);
          content = messageText(msg);
        }
        if (!content || content.length > 500) throw new Error('请引用有文字的消息，或填写1~500字符提醒内容');
        const ownerKey = `private:${d.ownerQQ()}`;
        if (!d.isAllowed(ownerKey)) throw new Error('管理员私聊当前不允许发送提醒');
        const list = d.reminders().get(ownerKey) || [];
        if (list.length >= d.reminderMax) throw new Error('个人提醒已达上限');
        const id = `r_${crypto.randomBytes(6).toString('hex')}`;
        d.backupReminders();
        d.reminders().set(ownerKey, [...list, { id, at: parsed.at, text: content, createdAt: now(), kind: 'ownerMemo', label: '个人提醒' }]);
        try { d.saveReminders(true); } catch (error) { d.reminders().set(ownerKey, list); throw error; }
        d.scheduleReminders();
        await respond(`已设置个人提醒 ${id}：${timeText(parsed.at)}。内容：${content}`);
      } else if (['任务改期', '任务内容', '暂停任务', '恢复任务', '任务顺延', '任务延期'].includes(c)) {
        requireArgs(a, ['暂停任务', '恢复任务'].includes(c) ? 1 : 2);
        const located = taskById(a[0]);
        await target(located.key, ctx.sourceKey);
        // 解析目标期间可能刚好到点；重新定位，不能修改已出队的旧数组。
        const found = taskById(a[0]);
        const changed = editOwnerReminder(found.item, c, a[1], now());
        d.backupReminders();
        found.list[found.index] = changed;
        try { d.saveReminders(true); } catch (error) { found.list[found.index] = found.item; throw error; }
        d.scheduleReminders();
        await respond(`${c}成功 ${changed.id}：${changed.paused ? '已暂停，不消耗次数' : timeText(changed.at)}｜${changed.text}`);
      } else if (['免打扰', '取消免打扰'].includes(c)) {
        requireArgs(a, c === '免打扰' ? 2 : 1);
        const t = await target(a[0], ctx.sourceKey);
        const st = d.getState(t.key);
        const parsed = c === '免打扰' ? parseChineseTime(/后$/.test(a[1]) ? a[1] : `${a[1]}后`, now()) : { ok: true, at: 0 };
        if (!parsed.ok || (parsed.at && (parsed.at <= now() || parsed.at - now() > 30 * 86400000))) throw new Error('免打扰请写30分钟、2小时等，最长30天');
        d.backupSocial();
        const old = st.proactiveQuietUntil;
        st.proactiveQuietUntil = parsed.at;
        try { d.saveState(true); } catch (error) { st.proactiveQuietUntil = old; throw error; }
        await respond(parsed.at ? `已免打扰至 ${timeText(parsed.at)}，到期自动恢复；正常回复、提醒和跟进照常。` : '已取消临时免打扰；原主动开关不变。');
      } else if (c === '诊断' || c === '会话诊断') {
        requireArgs(a, 1);
        const raw = await d.resolveTarget(['当前', '本群'].includes(a[0]) ? ctx.sourceKey : a[0]);
        if (!raw?.ok) throw new Error(raw?.message || '找不到目标');
        await respond(d.diagnose(raw.key));
      } else if (c === '别名设置') {
        requireArgs(a, 2);
        if (!validAlias(a[0])) throw new Error('别名须为1~20字中英文/数字/下划线，不能是纯数字、保留名或指令名');
        const t = await target(a[1], ctx.sourceKey);
        changeStore((owner) => {
          const prior = owner.aliases.find((item) => item.name === a[0]);
          if (prior && prior.key !== t.key && !confirmed) throw new Error(`别名已绑定 ${prior.key}；更换目标须在原指令末尾加[确认]`);
          if (!prior && owner.aliases.length >= 100) throw new Error('别名最多100个');
          owner.aliases = owner.aliases.filter((item) => item.name !== a[0]);
          owner.aliases.push({ name: a[0], key: t.key, label: t.name || t.key });
        });
        await respond(`别名「${a[0]}」已绑定 ${t.name || ''}（${t.key}）。`);
      } else if (c === '别名列表') {
        requireArgs(a, 0);
        const aliases = readOwner().aliases;
        await respond(`【目标别名】${aliases.length}个\n${aliases.map((item) => `${item.name} → ${item.label || ''}（${item.key}）`).join('\n') || '暂无；[别名设置][小群][群名]'}`);
      } else if (c === '别名删除') {
        requireArgs(a, 1);
        if (!confirmed) throw new Error('删除别名须在原指令末尾加[确认]');
        changeStore((owner) => {
          if (!owner.aliases.some((item) => item.name === a[0])) throw new Error('别名不存在');
          owner.aliases = owner.aliases.filter((item) => item.name !== a[0]);
        });
        await respond(`已删除别名「${a[0]}」。`);
      } else if (c === '记一下') {
        const content = a.join(' ').trim();
        if (!content || content.length > 500) throw new Error('待办内容须为1~500字符');
        const id = `n_${crypto.randomBytes(5).toString('hex')}`;
        changeStore((owner) => {
          if (owner.notes.length >= 500) throw new Error('待办最多500条，请先删除已完成项');
          owner.notes.push({ id, text: content, done: false, createdAt: now() });
        });
        await respond(`已记下 ${id}：${content}`);
      } else if (c === '待办') {
        requireArgs(a, 0, 2);
        const all = a[0] === '全部';
        const pageText = a[all ? 1 : 0] || '1';
        if (!/^\d+$/.test(pageText) || Number(pageText) < 1) throw new Error('页码须为正整数：[待办][2] 或 [待办][全部][2]');
        const notes = readOwner().notes.filter((item) => all || !item.done);
        const pages = Math.max(1, Math.ceil(notes.length / 20));
        const page = Number(pageText);
        if (page > pages) throw new Error(`只有${pages}页`);
        await respond(`【${all ? '全部' : '未完成'}待办】${notes.length}条 第${page}/${pages}页\n${notes.slice((page - 1) * 20, page * 20).map((item) => `${item.done ? '✓' : '○'} ${item.id} ${item.text}`).join('\n') || '暂无'}`);
      } else if (['完成待办', '恢复待办', '删除待办'].includes(c)) {
        requireArgs(a, 1);
        if (c === '删除待办' && !confirmed) throw new Error('删除须在原指令末尾加[确认]');
        changeStore((owner) => {
          const note = owner.notes.find((item) => item.id === a[0]);
          if (!note) throw new Error('没找到待办，请使用列表中的 n_xxx ID');
          if (c === '删除待办') owner.notes = owner.notes.filter((item) => item.id !== a[0]);
          else { note.done = c === '完成待办'; note.updatedAt = now(); }
        });
        await respond(`${c}成功：${a[0]}`);
      } else if (c === '搜消息' || c === '群摘要') {
        requireArgs(a, c === '搜消息' ? 2 : 1, c === '搜消息' ? 3 : 2);
        const t = await target(a[0], ctx.sourceKey);
        if (c === '群摘要' && t.kind !== 'group') throw new Error('群摘要请指定群名/群号');
        const count = countArg(a[c === '搜消息' ? 2 : 1]);
        const messages = await history(t, count);
        const range = `【${t.name || t.key}】请求最近${count}条，实际读取${messages.length}条${messages.length ? `｜${timeText(messages[0].time)}~${timeText(messages.at(-1).time)}` : ''}；仅覆盖本次接口返回记录，文字每条最多1200字符，超长部分不参与检索/摘要。`;
        if (c === '搜消息') {
          if (!a[1].trim() || a[1].length > 100) throw new Error('搜索词须为1~100字符');
          const hits = messages.filter((msg) => msg.text.toLowerCase().includes(a[1].toLowerCase()));
          await respond(`${range}\n匹配${hits.length}条，最多显示20条：\n${hits.slice(-20).map((msg) => `${timeText(msg.time)} ${msg.sender} [ID:${msg.id}]\n${msg.text.slice(0, 300)}`).join('\n') || '未找到；不代表更早记录不存在。'}`);
        } else {
          if (!messages.length) { await respond(`${range}\n没有可摘要消息。`); return true; }
          if (summaryBusy || (summaryAt && now() - summaryAt < 30000)) throw new Error('摘要正在处理或刚处理过，请30秒后再试');
          summaryBusy = true; summaryAt = now();
          try {
            const selected = [];
            let chars = 0;
            for (const msg of [...messages].reverse()) {
              const line = `${msg.sender}：${msg.text}`;
              if (chars + line.length + 1 > 24000) break;
              selected.unshift(line); chars += line.length + 1;
            }
            const output = await d.summarize(selected.join('\n'));
            if (!String(output || '').trim()) throw new Error('模型没有返回摘要');
            await respond(`${range}\n摘要实际使用其中最近${selected.length}条（输入上限24000字符）。\n【群摘要】\n${d.redact(String(output)).slice(0, 3000)}`);
          } finally { summaryBusy = false; }
        }
      } else if (c === '更正记忆') {
        requireArgs(a, 3);
        if (a[1].length < 2 || a[1].length > 100 || !a[2] || a[2].length > 200) throw new Error('旧内容须2~100字符，新内容须1~200字符');
        const t = await target(a[0], ctx.sourceKey);
        const st = d.getState(t.key);
        const matches = memoryCorrectionMatches(st, a[1]);
        if (matches.length !== 1) throw new Error(`匹配${matches.length}处；须唯一匹配，请把旧内容写得更具体`);
        const changed = applyMemoryCorrection(st, matches[0], a[1], a[2]);
        const previewKey = JSON.stringify([String(d.ownerQQ()), t.key, a[1], a[2]]);
        const signature = JSON.stringify([matches[0], changed.text]);
        if (!confirmed) {
          if (previews.size >= 20) previews.delete(previews.keys().next().value);
          previews.set(previewKey, { at: now(), signature });
          await respond(`【更正预览】${t.name || t.key}\n原：${matches[0].old}\n新：${changed.text}\n5分钟内发送相同指令并在末尾加[确认]。`);
          return true;
        }
        const preview = previews.get(previewKey);
        if (!preview || now() - preview.at > 300000 || preview.signature !== signature) throw new Error('预览缺失、过期或记忆已变化；请先不带确认重新预览');
        const affectedField = matches[0].list || 'memberImpressions';
        const beforeFlush = JSON.stringify(st[affectedField]);
        await d.flushMemory();
        if (beforeFlush !== JSON.stringify(st[affectedField])) throw new Error('记忆在保存前发生变化，请重新预览');
        d.backupSocial(); d.backupVectors();
        const field = matches[0].list || 'memberImpressions';
        const old = st[field];
        st[field] = changed.state[field];
        try { d.saveState(true); } catch (error) { st[field] = old; throw error; }
        previews.delete(previewKey);
        // 先移除旧向量，防止旧事实继续召回；索引失败仍保留已纠正的结构化记忆。
        try {
          await d.removeMemory(t.key, [{ kind: matches[0].category, ref: matches[0].ref }]);
          await d.indexMemory(t.key, matches[0].category, changed.ref, changed.item);
          await d.flushMemory();
          await respond('记忆已更正，原状态/向量已备份，向量索引已同步。');
        } catch {
          await respond('结构化记忆已更正并备份；向量同步失败，尚未完成索引同步，请稍后检查。');
        }
      } else if (['少聊话题', '恢复话题', '话题偏好'].includes(c)) {
        requireArgs(a, c === '话题偏好' ? 1 : 2);
        const t = await target(a[0], ctx.sourceKey);
        const st = d.getState(t.key);
        if (c !== '话题偏好') {
          if (!/^[\p{L}\p{N} _-]{1,20}$/u.test(a[1])) throw new Error('话题须1~20字中英文/数字，不含控制符');
          const old = st.proactiveAvoidTopics;
          const topics = Array.isArray(old) ? old : [];
          const next = c === '少聊话题' ? [...new Set([...topics, a[1]])] : topics.filter((item) => item !== a[1]);
          if (next.length > 10) throw new Error('每会话最多10个少聊话题');
          d.backupSocial(); st.proactiveAvoidTopics = next;
          try { d.saveState(true); } catch (error) { st.proactiveAvoidTopics = old; throw error; }
        }
        await respond(`【${t.name || t.key}话题偏好】\n少主动提：${(st.proactiveAvoidTopics || []).join('、') || '暂无'}\n只影响主动开口，对方主动聊到仍可正常接话。`);
      }
      d.audit?.(`[owner-tools] ${ctx.sourceKey} ${c}`);
    } catch (error) {
      await respond(`未完成：${String(error?.message || '操作失败').slice(0, 200)}`);
    }
    return true;
  }
  return { handle, aliasTarget, readOwner };
}
