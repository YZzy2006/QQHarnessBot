import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createOwnerTools, backupOwnerFile } from '../src/owner-tools.js';
const OWNER = 123, GROUP = 12345, FRIEND = 23456;
let pass = 0;
const bridge = await bridgeHarness({
  config: {
    sendDelayMinMs: 0, sendDelayMaxMs: 0,
    allow: { private: [String(OWNER), String(FRIEND)], groups: [String(GROUP)] }
  },
  globals: {
    createOwnerTools: (deps) => createOwnerTools({
      ...deps, flushMemory: async () => {}, removeMemory: async () => 0, indexMemory: async () => true,
      summarize: async () => '主要话题：报告。结论：周五提交。待办：甲提交报告。'
    })
  }
});
const { calls, temp } = bridge;
calls.groups = [{ group_id: GROUP, group_name: '测试 群聊' }];
calls.qzoneFriends = [{ user_id: FRIEND, nickname: '示例好友甲', remark: '示例好友甲' }];
bridge.setMode('reserved2'); bridge.setReady(true);
bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
let seq = 100;
async function command(text, { kind = 'private', id = OWNER, userId = OWNER, quote } = {}) {
  calls.sent.length = 0;
  const message = [{ type: 'text', data: { text } }];
  if (quote !== undefined) message.unshift({ type: 'reply', data: { id: String(quote) } });
  await bridge.handleIncoming(kind, id, { user_id: userId, group_id: kind === 'group' ? id : undefined, self_id: calls.selfUin, message_id: seq++, sender: { nickname: '管理员' }, message }, bridge.cfg);
  return calls.sent.map((item) => item.text).join('\n');
}
async function test(name, fn) {
  try { await fn(); pass++; }
  catch (error) { console.error(`FAIL ${name}: ${error.stack}`); process.exitCode = 1; }
}

await test('管理员私聊便捷帮助和分页帮助注册', async () => {
  assert.match(await command('[便捷帮助]'), /任务顺延/);
  assert.match(await command('[指令 便捷]'), /十三、便捷工具/);
  assert.match(await command('[指令]'), /13\./);
});
await test('别名复用到已有主动状态、群信息解析', async () => {
  assert.match(await command('[别名设置][小群][测试 群聊]'), /已绑定/);
  assert.equal((await bridge.resolveAnyTarget('小群')).key, `group:${GROUP}`);
  assert.match(await command('[主动状态][小群]'), /主动/);
  assert.match(await command('[群信息][小群]'), /12345/);
});
await test('群内新指令有回应，便签内容只发管理员', async () => {
  const reply = await command('[记一下][这是私有待办内容]', { kind: 'group', id: GROUP });
  assert.match(reply, /已私聊/);
  const groupMessages = calls.sent.filter((item) => item.kind === 'group');
  assert.ok(groupMessages.length > 0);
  assert.ok(groupMessages.every((item) => !item.text.includes('私有待办内容')));
  const privateMessages = calls.sent.filter((item) => item.kind === 'private');
  assert.ok(privateMessages.some((item) => item.text.includes('私有待办内容')));
  assert.ok(privateMessages.every((item) => Number(item.id) === OWNER));
});
await test('群内已有状态/帮助也明确响应并私聊', async () => {
  assert.match(await command('[状态]', { kind: 'group', id: GROUP }), /机器人状态/);
  assert.ok(calls.sent.some((item) => item.kind === 'group' && item.text.includes('已私聊')));
  assert.match(await command('[指令]', { kind: 'group', id: GROUP }), /指令/);
  assert.ok(calls.sent.some((item) => item.kind === 'private'));
  await command('[全部好友]', { kind: 'group', id: GROUP });
  assert.ok(calls.sent.some((item) => item.kind === 'group' && item.text.includes('已私聊')));
  assert.ok(calls.sent.some((item) => item.kind === 'private' && item.text.includes('示例好友甲')));
});
await test('非管理员同群发送便签/撤回指令不产生管理动作', async () => {
  const before = fs.readFileSync(path.join(temp, 'state/owner-tools.json'), 'utf8');
  const deletes = calls.deletedMsgs.length;
  await command('[记一下][不能写入]', { kind: 'group', id: GROUP, userId: FRIEND });
  await command('[撤回此条][小群][-101][确认]', { kind: 'group', id: GROUP, userId: FRIEND });
  assert.equal(fs.readFileSync(path.join(temp, 'state/owner-tools.json'), 'utf8'), before);
  assert.equal(calls.deletedMsgs.length, deletes);
  bridge.retireSession(`group:${GROUP}`, 'fixture cleanup');
});
await test('群中撤回最近作用于原群，不作用于私聊回执', async () => {
  calls.groupHistory = [{ message_id: -201, time: Date.now() / 1000, sender: { user_id: calls.selfUin }, message: [{ type: 'text', data: { text: '机器人在群里发的' } }] }];
  calls.friendHistory = [{ message_id: -202, time: Date.now() / 1000, sender: { user_id: calls.selfUin }, message: [{ type: 'text', data: { text: '私聊回执' } }] }];
  assert.match(await command('[撤回最近 确认]', { kind: 'group', id: GROUP }), /撤回/);
  const deleted = calls.deletedMsgs.at(-1);
  assert.equal(Number(deleted.message_id ?? deleted), -201);
});
await test('引用回应、私聊跨群引用ID和防跨会话', async () => {
  calls.getMessageData['-101'] = { message_id: -101, message_type: 'group', group_id: GROUP, sender: { user_id: calls.selfUin }, message: [{ type: 'text', data: { text: '周五交报告' } }] };
  calls.getMessageData['-102'] = { message_id: -102, message_type: 'group', group_id: 77777, message: [{ type: 'text', data: { text: '别的群' } }] };
  assert.match(await command('[回应 👍]', { kind: 'group', id: GROUP, quote: -101 }), /已添加/);
  assert.equal(calls.emojiLikes.at(-1).message_id, -101);
  const before = calls.deletedMsgs.length;
  assert.match(await command('[撤回此条][小群][-102][确认]'), /不属于指定会话/);
  assert.equal(calls.deletedMsgs.length, before);
  assert.match(await command('[撤回此条][小群][-101][确认]'), /已撤回/);
});
await test('个人提醒、任务编辑和暂停状态保存/重载', async () => {
  const text = await command('[提醒我][2小时后][测试个人提醒]');
  const id = text.match(/r_[a-f0-9]+/)[0];
  assert.match(await command(`[任务内容][${id}][更新后的个人提醒]`), /成功/);
  assert.match(await command(`[暂停任务][${id}]`), /已暂停/);
  const originalAt = bridge.getReminders().get(`private:${OWNER}`).find((r) => r.id === id).at;
  bridge.getReminders().clear(); bridge.loadReminders();
  const restored = bridge.getReminders().get(`private:${OWNER}`).find((r) => r.id === id);
  assert.equal(restored.paused, true);
  assert.equal(restored.at, originalAt);
  assert.equal(restored.text, '更新后的个人提醒');
  assert.match(await command('[定时任务][查看所有]'), /已暂停/);
  assert.match(await command(`[恢复任务][${id}]`), /成功/);
  assert.match(await command(`[任务顺延][${id}][30分钟]`), /成功/);
  assert.equal(bridge.getReminders().get(`private:${OWNER}`).find((r) => r.id === id).at, originalAt + 1800000);
});
await test('暂停到期任务不会投递或消耗次数', async () => {
  const reminder = { id: 'r_aaaa11112222', at: Date.now() - 1000, text: '不能发', kind: 'ownerTask', paused: true, repeat: 'daily', remaining: 2 };
  bridge.getReminders().set(`group:${GROUP}`, [reminder]);
  const before = calls.prompts.length;
  await bridge.fireDueReminders();
  assert.equal(calls.prompts.length, before);
  assert.equal(bridge.getReminders().get(`group:${GROUP}`)[0].remaining, 2);
});
await test('个人提醒到点直接发管理员，不唤醒模型', async () => {
  bridge.getReminders().set(`private:${OWNER}`, [{ id: 'r_cccc11112222', at: Date.now() - 1000, text: '直接提醒测试', kind: 'ownerMemo' }]);
  calls.sent.length = 0;
  const before = calls.prompts.length;
  await bridge.fireDueReminders();
  assert.equal(calls.prompts.length, before);
  assert.ok(calls.http.some((item) => item.url.endsWith('/send_private_msg') && item.body.user_id === OWNER && JSON.stringify(item.body.message).includes('直接提醒测试')));
});
await test('免打扰持久化并阻止自动补投，手动唤醒绕过', async () => {
  assert.match(await command('[免打扰][小群][2小时]'), /到期自动恢复/);
  const st = bridge.getSocialV2State(`group:${GROUP}`);
  assert.ok(st.proactiveQuietUntil > Date.now());
  const disk = JSON.parse(fs.readFileSync(path.join(temp, 'state/social-v2.json')));
  assert.equal(disk.conversations[`group:${GROUP}`].proactiveQuietUntil, st.proactiveQuietUntil);
  const block = await bridge.sendWakePromptV2(`group:${GROUP}`, 'proactiveCheck');
  assert.equal(block.skipped, true);
  assert.match(block.error, /免打扰/);
  bridge.retireSession(`group:${GROUP}`, 'fixture cleanup');
  clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null;
  st.wakeTimes = []; st.unread = []; st.lastWakeAt = 0;
  const before = calls.prompts.length;
  assert.match(await command('[主动唤醒][小群]'), /已唤醒/);
  assert.ok(calls.prompts.length > before);
  bridge.retireSession(`group:${GROUP}`, 'fixture cleanup');
});
await test('诊断含权限/免打扰/额度与明确原因，不含会话令牌', async () => {
  const text = await command('[诊断][小群]');
  assert.match(text, /会话诊断/); assert.match(text, /免打扰/); assert.match(text, /发送限额/);
  const st = bridge.getSocialV2State(`group:${GROUP}`);
  assert.ok(st.agentToken);
  assert.ok(!text.includes(st.agentToken));
  assert.match(await command('[诊断][group:99999]'), /不允许/);
});
await test('消息搜索返回范围与ID，群摘要只回管理员', async () => {
  calls.groupHistory = [{ message_id: -501, time: Date.now() / 1000, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '周五交报告' } }] }];
  assert.match(await command('[搜消息][小群][报告][最近20条]'), /ID:-501/);
  const text = await command('[群摘要][小群][最近20条]', { kind: 'group', id: GROUP });
  assert.match(text, /周五提交/);
  assert.ok(calls.sent.filter((item) => item.kind === 'group').every((item) => !item.text.includes('周五提交')));
});
await test('话题偏好注入真实主动prompt，记忆纠正预览确认', async () => {
  await command('[少聊话题][小群][游戏]');
  const prompt = await bridge.buildWakePromptV2(`group:${GROUP}`, 'proactiveCheck');
  assert.match(prompt, /少主动提：游戏/);
  const st = bridge.getSocialV2State(`group:${GROUP}`);
  st.activeTopics = [{ text: '周五去图书馆' }];
  assert.match(await command('[更正记忆][小群][周五去图书馆][周六去图书馆]'), /更正预览/);
  assert.match(await command('[更正记忆][小群][周五去图书馆][周六去图书馆][确认]'), /记忆已更正/);
  assert.equal(st.activeTopics[0].text, '周六去图书馆');
  const raw = JSON.parse(fs.readFileSync(path.join(temp, 'state/social-v2.json')));
  assert.equal(raw.conversations[`group:${GROUP}`].activeTopics[0].text, '周六去图书馆');
});
await test('已查看任务到点后取消序号不误删下一条', async () => {
  const a = { id: 'r_aaaa33334444', at: Date.now() + 100000, text: '第一条', kind: 'ownerTask' };
  const b = { id: 'r_bbbb33334444', at: Date.now() + 200000, text: '第二条', kind: 'ownerTask' };
  bridge.getReminders().clear(); bridge.getReminders().set(`group:${GROUP}`, [a, b]);
  await command('[定时任务][查看所有]');
  bridge.getReminders().set(`group:${GROUP}`, [b]);
  assert.match(await command('[定时任务][取消 1]'), /没找到/);
  assert.equal(bridge.getReminders().get(`group:${GROUP}`)[0].id, b.id);
});
await test('真实摘要适配器沿用模型档位、不携带工具、用量入账', async () => {
  // 新建工具实例清除前一个测试的30秒摘要冷却，仅替换测试依赖。
  const other = await bridgeHarness({
    config: { sendDelayMinMs: 0, sendDelayMaxMs: 0, allow: { private: [String(OWNER)], groups: [String(GROUP)] } }
  });
  try {
    other.calls.groups = calls.groups; other.calls.groupHistory = calls.groupHistory;
    fs.writeFileSync(path.join(other.temp, 'state/.deepseek-key'), 'fixture-only-summary-key');
    other.setMode('reserved2'); other.setReady(true); other.setPresets(['standard', 'qq-chat-v2']);
    const before = other.calls.created.length;
    await other.handleIncoming('private', OWNER, { user_id: OWNER, self_id: calls.selfUin, message_id: 901, message: [{ type: 'text', data: { text: '[群摘要][测试 群聊][最近20条]' } }] }, other.cfg);
    const request = other.calls.http.find((item) => item.url === 'https://api.deepseek.com/chat/completions');
    assert.ok(request);
    assert.equal(request.body.model, other.cfg.dsh.model);
    assert.equal(request.body.reasoning_effort, other.cfg.dsh.reasoningEffort);
    assert.equal(request.body.tools, undefined);
    assert.equal(request.body.messages[0].role, 'system');
    assert.match(request.body.messages[0].content, /不可信/);
    assert.equal(other.calls.created.length, before);
    assert.equal(other.calls.prompts.length, 0);
    const ledger = fs.readFileSync(path.join(other.temp, 'state/token-usage.jsonl'), 'utf8');
    assert.match(ledger, /internal:群摘要/);
    assert.match(ledger, /"cacheMiss":20/);
    assert.match(ledger, /"cacheHit":10/);
    assert.ok(other.calls.sent.every((item) => item.kind === 'private' && Number(item.id) === OWNER));
  } finally { await other.close(); }
});
await test('取消任务备份/写入失败保留内存和磁盘，不假报成功', async () => {
  let failBackup = false;
  let failWrite = false;
  const other = await bridgeHarness({
    config: { sendDelayMinMs: 0, sendDelayMaxMs: 0 },
    globals: {
      backupOwnerFile: (file) => { if (failBackup) throw new Error('fixture backup failure'); return backupOwnerFile(file); },
      fs: { ...fs, renameSync: (from, to) => { if (failWrite && String(to).endsWith('reminders.json')) throw new Error('fixture write failure'); return fs.renameSync(from, to); } }
    }
  });
  try {
    const reminder = { id: 'r_dddd33334444', at: Date.now() + 999000, kind: 'ownerTask', text: '应保留' };
    other.getReminders().set('group:456', [reminder]); other.saveReminders(true);
    const before = fs.readFileSync(path.join(other.temp, 'state/reminders.json'), 'utf8');
    const sendCancel = () => other.handleIncoming('private', OWNER, { user_id: OWNER, self_id: calls.selfUin, message_id: seq++, message: [{ type: 'text', data: { text: '[定时任务][取消 r_dddd33334444]' } }] }, other.cfg);
    failBackup = true; await sendCancel();
    assert.match(other.calls.sent.at(-1).text, /取消未完成/);
    assert.equal(other.getReminders().get('group:456')[0].id, reminder.id);
    failBackup = false; failWrite = true; await sendCancel();
    assert.match(other.calls.sent.at(-1).text, /取消未完成/);
    assert.equal(other.getReminders().get('group:456')[0].id, reminder.id);
    assert.equal(fs.readFileSync(path.join(other.temp, 'state/reminders.json'), 'utf8'), before);
  } finally { await other.close(); }
});
await bridge.close();
console.log(`owner-tools bridge tests: ${pass} passed${process.exitCode ? ', failures above' : ''}`);
