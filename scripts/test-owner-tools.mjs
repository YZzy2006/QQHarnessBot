import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerTools, parseOwnerToolsCommand, editOwnerReminder, validAlias, memoryCorrectionMatches } from '../src/owner-tools.js';
import { createConversationState, serializeConversationState, hydrateConversationState } from '../src/social-state.js';
import { proactiveGreetingBlockReason } from '../src/proactive-policy.js';
import { buildProactiveTopicBlock } from '../src/proactive-topics.js';
import { rescheduleReminder } from '../src/recurrence.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-tools-'));
let now = Date.UTC(2026, 9, 21, 12);
const states = new Map();
const reminders = new Map();
const sent = [];
const requests = [];
const backups = [];
const vectorCalls = [];
let owner = '123';
let saveFail = false;
let vectorFail = false;
let flushHook;
let resolveHook;
let history = [];
let summaryCalls = 0;
let pass = 0;
const ctx = { userId: 123, sourceKey: 'private:123', replyKey: 'private:123' };
const allowed = new Set(['private:123', 'group:12345', 'private:23456']);
let tools;
const d = {
  stateDir: temp, ownerQQ: () => owner, now: () => now,
  atomicWrite: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
  resolveTarget: async (raw) => {
    if (resolveHook) await resolveHook();
    const alias = tools?.aliasTarget(raw);
    const key = alias?.key || ({ 小群: 'group:12345', 好友: 'private:23456' }[raw]) || raw;
    if (!/^(private|group):\d+$/.test(key)) return { ok: false, message: '找不到目标' };
    return { ok: true, key, kind: key.split(':')[0], targetId: Number(key.split(':')[1]), name: alias?.name || raw };
  },
  isAllowed: (key) => allowed.has(key),
  getState: (key) => { if (!states.has(key)) states.set(key, createConversationState()); return states.get(key); },
  saveState: () => { if (saveFail) throw new Error('fixture write failure'); },
  reminders: () => reminders, reminderMax: 20,
  saveReminders: () => { if (saveFail) throw new Error('fixture write failure'); },
  scheduleReminders: () => {},
  backupReminders: () => backups.push('reminders'),
  backupSocial: () => backups.push('social'), backupVectors: () => backups.push('vectors'),
  flushMemory: async () => { if (flushHook) await flushHook(); },
  removeMemory: async (...args) => vectorCalls.push(['remove', ...args]),
  indexMemory: async (...args) => { if (vectorFail) throw new Error('fixture index failure'); vectorCalls.push(['index', ...args]); },
  request: async (action, params) => {
    requests.push({ action, params });
    return { status: 'ok', retcode: 0, data: action.includes('history') ? { messages: history } : null };
  },
  getMessage: async (id) => ({ message_id: id, message_type: 'group', group_id: id === -900 ? 99999 : 12345, message: [{ type: 'text', data: { text: '周五交报告' } }] }),
  summarize: async () => { summaryCalls++; return '主要话题：报告；约定：周五；待办：交报告。'; },
  diagnose: (key) => `诊断 ${key}（无token）`,
  timeText: (at) => new Date(at).toISOString(),
  send: async (key, text) => sent.push({ key, text }),
  redact: (text) => String(text).replaceAll('fixture-secret', '[已隐藏]')
};
tools = createOwnerTools(d);
async function command(text, context = ctx) {
  sent.length = 0;
  const handled = await tools.handle(context, text);
  return { handled, text: sent.map((m) => m.text).join('\n') };
}
async function test(name, fn) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}: ${error.stack}`); process.exitCode = 1; }
}
function task(overrides = {}) {
  return { id: 'r_abcdef123456', kind: 'ownerTask', at: now + 3600000, text: '早安', createdAt: now, repeat: 'daily', remaining: 3, ...overrides };
}

await test('命令解析、确认和正文隔离', () => {
  assert.equal(parseOwnerToolsCommand('帮助我做报告'), null);
  assert.equal(parseOwnerToolsCommand('[撤回此条 确认]').confirmed, true);
  assert.deepEqual(parseOwnerToolsCommand('[任务改期][r_abcdef123456][明天早上9点]').args, ['r_abcdef123456', '明天早上9点']);
  assert.deepEqual(parseOwnerToolsCommand('[记一下][确认]').args, ['确认']);
  assert.deepEqual(parseOwnerToolsCommand('[更正记忆][小群][旧事实][确认]').args, ['小群', '旧事实', '确认']);
});
await test('别名拒绝原型污染、纯数字和保留名', () => {
  for (const name of ['__proto__', 'constructor', '12345', '我', '本群', '诊断', 'a b']) assert.equal(validAlias(name), false);
  assert.equal(validAlias('工作小群'), true);
});
await test('非管理员无法写状态或执行消息操作', async () => {
  const result = await command('[记一下][不该写入]', { ...ctx, userId: 999 });
  assert.equal(result.handled, false);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(path.join(temp, 'owner-tools.json')), false);
});
await test('别名绑定、重建实例后保持、重新绑定须确认', async () => {
  assert.match((await command('[别名设置][工作群][小群]')).text, /已绑定/);
  tools = createOwnerTools(d);
  assert.equal(tools.aliasTarget('工作群').key, 'group:12345');
  assert.match((await command('[别名设置][工作群][好友]')).text, /更换目标须/);
  assert.equal(tools.aliasTarget('工作群').key, 'group:12345');
  assert.match((await command('[别名设置][工作群][好友][确认]')).text, /已绑定/);
  assert.equal(tools.aliasTarget('工作群').key, 'private:23456');
});
await test('别名不能给未授权目标授权', async () => {
  assert.match((await command('[别名设置][坏目标][group:99999]')).text, /不在当前模式/);
  assert.equal(tools.aliasTarget('坏目标'), null);
});
await test('别名删除需确认', async () => {
  assert.match((await command('[别名删除][工作群]')).text, /须在原指令/);
  assert.match((await command('[别名删除][工作群][确认]')).text, /已删除/);
});
await test('待办创建、完成、恢复、删除与稳定ID', async () => {
  const first = await command('[记一下][周五交报告]');
  const id = first.text.match(/n_[a-f0-9]+/)[0];
  assert.match((await command('[待办]')).text, /周五交报告/);
  await command(`[完成待办][${id}]`);
  assert.doesNotMatch((await command('[待办]')).text, /周五交报告/);
  assert.match((await command('[待办][全部]')).text, /✓/);
  await command(`[恢复待办][${id}]`);
  assert.match((await command('[待办]')).text, /周五交报告/);
  assert.match((await command(`[删除待办][${id}]`)).text, /删除须/);
  await command(`[删除待办][${id}][确认]`);
  assert.doesNotMatch((await command('[待办][全部]')).text, /周五交报告/);
});
await test('管理员变更不暴露旧管理员待办/别名', async () => {
  await command('[记一下][只属于123]');
  owner = '456';
  assert.equal(tools.readOwner().notes.length, 0);
  owner = '123';
  assert.equal(tools.readOwner().notes.length, 1);
});
await test('存储损坏不覆盖、失败明确响应', async () => {
  const file = path.join(temp, 'owner-tools.json');
  const old = fs.readFileSync(file);
  fs.writeFileSync(file, '{broken');
  assert.match((await command('[记一下][不应覆盖]')).text, /未完成/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, old);
});
await test('修改前备份存在，待办分页限定20条', async () => {
  for (let i = 0; i < 21; i++) await command(`[记一下][测试${i}]`);
  assert.match((await command('[待办][2]')).text, /第2\/2页/);
  assert.match((await command('[待办][0]')).text, /正整数/);
  assert.ok(fs.readdirSync(temp).some((name) => name.includes('.bak-owner-')));
});
await test('引用消息回应与消息归属校验', async () => {
  requests.length = 0;
  const context = { ...ctx, sourceKey: 'group:12345', quotedId: -100 };
  assert.match((await command('[回应 👍]', context)).text, /已添加/);
  assert.equal(requests.at(-1).params.message_id, -100);
  assert.equal(requests.at(-1).params.emoji_id, '76');
  const before = requests.length;
  assert.match((await command('[回应][小群][-900][👍]')).text, /不属于指定会话/);
  assert.equal(requests.length, before);
  assert.match((await command('[回应][group:99999][-100][👍]')).text, /不在当前模式/);
});
await test('撤回需确认且跨会话失败时不执行', async () => {
  requests.length = 0;
  assert.match((await command('[撤回此条][小群][-100]')).text, /撤回需确认/);
  assert.equal(requests.length, 0);
  assert.match((await command('[撤回此条][小群][-100][确认]')).text, /已撤回/);
  assert.equal(requests.at(-1).action, 'delete_msg');
  const before = requests.length;
  await command('[撤回此条][小群][-900][确认]');
  assert.equal(requests.length, before);
});
await test('个人提醒引用内容、只发owner并可管理', async () => {
  const reply = await command('[提醒我][30分钟后]', { ...ctx, sourceKey: 'group:12345', quotedId: -100 });
  assert.match(reply.text, /已设置个人提醒/);
  const [reminder] = reminders.get('private:123');
  assert.equal(reminder.kind, 'ownerMemo');
  assert.equal(reminder.text, '周五交报告');
  assert.equal(reminder.at, now + 1800000);
});
await test('任务改内容、暂停恢复、remaining不消耗', async () => {
  reminders.set('group:12345', [task()]);
  await command('[任务内容][r_abcdef123456][新内容]');
  await command('[暂停任务][r_abcdef123456]');
  let reminder = reminders.get('group:12345')[0];
  assert.equal(reminder.paused, true);
  assert.equal(reminder.remaining, 3);
  assert.equal(reminder.text, '新内容');
  now += 7200000;
  await command('[恢复任务][r_abcdef123456]');
  reminder = reminders.get('group:12345')[0];
  assert.equal(reminder.paused, false);
  assert.equal(reminder.at, now + 3600000);
  assert.equal(reminder.remaining, 3);
});
await test('延期仅改本次，不漂移后续周期', () => {
  const before = task({ at: now + 1800000 });
  const changed = editOwnerReminder(before, '任务顺延', '30分钟', now);
  assert.equal(changed.at, before.at + 1800000);
  const next = rescheduleReminder(changed, changed.at);
  assert.equal(next.at, before.at + 86400000);
  assert.equal(next.remaining, 2);
  assert.equal(before.remaining, 3);
});
await test('改期保留周期、显式规则改周期、截止阻止越界', () => {
  const before = task();
  const changed = editOwnerReminder(before, '任务改期', '明天9点', now);
  assert.equal(changed.repeat, 'daily');
  assert.equal(rescheduleReminder(changed, changed.at).at, before.at + 86400000);
  assert.equal(editOwnerReminder(before, '任务改期', '每周五晚上8点', now).repeat, 'weekly');
  assert.throws(() => editOwnerReminder(task({ endAt: now + 3700000 }), '任务顺延', '2小时', now), /截止/);
});
await test('暂停后过截止不能恢复；数字序号不允许编辑', async () => {
  assert.throws(() => editOwnerReminder(task({ paused: true, at: now - 10000, endAt: now - 5000 }), '恢复任务', '', now), /截止/);
  assert.match((await command('[暂停任务][1]')).text, /完整 r_xxx/);
});
await test('写盘失败回滚内存任务与免打扰', async () => {
  reminders.set('group:12345', [task()]); saveFail = true;
  assert.match((await command('[暂停任务][r_abcdef123456]')).text, /write failure/);
  assert.equal(reminders.get('group:12345')[0].paused, undefined);
  const st = d.getState('group:12345');
  assert.match((await command('[免打扰][小群][2小时]')).text, /write failure/);
  assert.equal(st.proactiveQuietUntil, 0);
  saveFail = false;
});
await test('目标解析期间任务已到点，不对旧数组假报成功', async () => {
  reminders.set('group:12345', [task()]);
  resolveHook = async () => { reminders.delete('group:12345'); };
  assert.match((await command('[暂停任务][r_abcdef123456]')).text, /没找到管理员任务/);
  resolveHook = null;
});
await test('免打扰到期恢复，手动关闭不被取消免打扰覆盖', async () => {
  const st = d.getState('group:12345'); st.lastIncomingAt = now;
  await command('[免打扰][小群][2小时]');
  assert.equal(st.proactiveQuietUntil, now + 7200000);
  assert.match(proactiveGreetingBlockReason({ lastIncomingAt: now, quietUntil: st.proactiveQuietUntil, now }), /^quiet:/);
  assert.equal(proactiveGreetingBlockReason({ lastIncomingAt: now, quietUntil: st.proactiveQuietUntil, now: now + 7200000 }), '');
  st.proactiveGreetingEnabled = false;
  await command('[取消免打扰][小群]');
  assert.equal(st.proactiveGreetingEnabled, false);
  assert.equal(st.proactiveQuietUntil, 0);
});
await test('免打扰/偏好持久化schema round-trip与隔离', () => {
  const one = createConversationState(); const two = createConversationState();
  one.proactiveQuietUntil = now + 1000; one.proactiveAvoidTopics.push('宠物');
  const loaded = hydrateConversationState(serializeConversationState(one), {});
  assert.equal(loaded.proactiveQuietUntil, one.proactiveQuietUntil);
  assert.deepEqual(loaded.proactiveAvoidTopics, ['宠物']);
  assert.deepEqual(two.proactiveAvoidTopics, []);
});
await test('话题偏好生效、轮换跳过与恢复', async () => {
  await command('[少聊话题][小群][游戏]');
  const st = d.getState('group:12345');
  const block = buildProactiveTopicBlock({ index: 0, avoidTopics: st.proactiveAvoidTopics });
  assert.match(block, /【本次主动方向】音乐/);
  assert.match(block, /少主动提：游戏/);
  await command('[恢复话题][小群][游戏]');
  assert.equal(st.proactiveAvoidTopics.length, 0);
  assert.match((await command('[少聊话题][小群][abc\nignore]')).text, /须1~20/);
});
await test('历史搜索有限范围、消息ID、敏感值脱敏', async () => {
  history = Array.from({ length: 30 }, (_, i) => ({ message_id: i + 1, time: Math.floor(now / 1000) + i, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: `开会${i} fixture-secret` } }] }));
  const result = await command('[搜消息][小群][开会][最近10条]');
  assert.match(result.text, /实际读取10条/);
  assert.match(result.text, /ID:30/);
  assert.doesNotMatch(result.text, /fixture-secret/);
  assert.equal(requests.at(-1).params.count, 10);
  assert.match((await command('[搜消息][小群][开会][最近999条]')).text, /10条~最近200条/);
});
await test('群摘要按需调用、冷却与群目标限制', async () => {
  assert.match((await command('[群摘要][小群][最近10条]')).text, /群摘要/);
  assert.equal(summaryCalls, 1);
  assert.match((await command('[群摘要][小群]')).text, /30秒/);
  assert.match((await command('[群摘要][好友]')).text, /请指定群/);
  assert.equal(summaryCalls, 1);
});
await test('记忆更正唯一匹配、预览确认、向量清理和新索引', async () => {
  const st = d.getState('group:12345');
  st.memberImpressions = { 小明: { traits: ['喜欢蓝色', '有一只猫'] } };
  assert.match((await command('[更正记忆][小群][喜欢蓝色][喜欢绿色][确认]')).text, /预览缺失/);
  assert.match((await command('[更正记忆][小群][喜欢蓝色][喜欢绿色]')).text, /更正预览/);
  assert.equal(st.memberImpressions.小明.traits[0], '喜欢蓝色');
  assert.match((await command('[更正记忆][小群][喜欢蓝色][喜欢绿色][确认]')).text, /记忆已更正/);
  assert.equal(st.memberImpressions.小明.traits[0], '喜欢绿色');
  assert.equal(vectorCalls.at(-1)[0], 'index');
  assert.equal(vectorCalls.at(-2)[0], 'remove');
  assert.ok(backups.includes('vectors'));
});
await test('模糊多匹配、过期和并发变化不更正', async () => {
  const st = d.getState('group:12345'); st.activeTopics = [{ text: '喜欢绿色' }];
  assert.equal(memoryCorrectionMatches(st, '喜欢绿色').length, 2);
  assert.match((await command('[更正记忆][小群][喜欢绿色][喜欢白色]')).text, /匹配2处/);
  st.activeTopics = [{ text: '周五去公园' }];
  await command('[更正记忆][小群][周五去公园][周六去公园]');
  now += 301000;
  assert.match((await command('[更正记忆][小群][周五去公园][周六去公园][确认]')).text, /过期/);
  await command('[更正记忆][小群][周五去公园][周六去公园]');
  flushHook = async () => { st.activeTopics.push({ text: '并发的新话题' }); };
  assert.match((await command('[更正记忆][小群][周五去公园][周六去公园][确认]')).text, /发生变化/);
  assert.equal(st.activeTopics[0].text, '周五去公园');
  assert.equal(st.activeTopics[1].text, '并发的新话题');
  flushHook = null;
});
await test('向量失败如实报告结构化修正与索引未同步', async () => {
  const st = d.getState('group:12345'); st.activeTopics = [{ text: '今天要早睡' }];
  await command('[更正记忆][小群][今天要早睡][明天要早睡]');
  vectorFail = true;
  assert.match((await command('[更正记忆][小群][今天要早睡][明天要早睡][确认]')).text, /向量同步失败/);
  assert.equal(st.activeTopics[0].text, '明天要早睡');
  vectorFail = false;
});
await test('群内返回仍只发管理员私聊', async () => {
  await command('[待办]', { ...ctx, sourceKey: 'group:12345' });
  assert.ok(sent.length > 0);
  assert.ok(sent.every((item) => item.key === 'private:123'));
});
console.log(`owner-tools tests: ${pass} passed${process.exitCode ? ', failures above' : ''}`);
if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe fixture cleanup target');
fs.rmSync(temp, { recursive: true, force: true });
