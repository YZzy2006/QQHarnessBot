#!/usr/bin/env node
// owner 控制台指令：纯解析/格式化测试。无网络、无状态。
import assert from 'node:assert/strict';
import {
  parseOwnerConsoleCommand, formatStatus, formatConversations, formatGroups,
  formatGroupMembers, formatRecentErrors, formatReminders, formatDeepSeekBalance, CONSOLE_HELP
} from '../src/owner-console.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

test('解析：状态/会话/群/成员/错误/提醒/帮助', () => {
  assert.equal(parseOwnerConsoleCommand('[状态]').action, 'status');
  assert.equal(parseOwnerConsoleCommand('[运行状态]').action, 'status');
  assert.equal(parseOwnerConsoleCommand('[会话列表]').action, 'conversations');
  assert.equal(parseOwnerConsoleCommand('[群列表]').action, 'groups');
  const members = parseOwnerConsoleCommand('[群成员 7000001]');
  assert.equal(members.action, 'groupMembers');
  assert.equal(members.groupId, 7000001);
  assert.equal(parseOwnerConsoleCommand('[群成员]').action, 'groupMembers');
  assert.equal(parseOwnerConsoleCommand('[群成员]').groupId, 0);
  assert.equal(parseOwnerConsoleCommand('[最近错误]').action, 'errors');
  assert.equal(parseOwnerConsoleCommand('[余额]').action, 'deepseekBalance');
  assert.equal(parseOwnerConsoleCommand('[DeepSeek余额]').action, 'deepseekBalance');
  assert.equal(parseOwnerConsoleCommand('[提醒列表]').action, 'reminders');
  const cancel = parseOwnerConsoleCommand('[取消提醒 r_12345678]');
  assert.equal(cancel.action, 'cancelReminder');
  assert.equal(cancel.id, 'r_12345678');
  assert.equal(parseOwnerConsoleCommand('[控制台帮助]').action, 'help');
});

test('解析：普通聊天不拦截', () => {
  assert.equal(parseOwnerConsoleCommand('我今天状态不好').ok, false);
  assert.equal(parseOwnerConsoleCommand('群里有人吗').ok, false);
  assert.equal(parseOwnerConsoleCommand('你好').ok, false);
});

test('状态格式化', () => {
  const text = formatStatus({
    mode: 'reserved2',
    uptimeMs: 2 * 86400 * 1000 + 3 * 3600 * 1000,
    selfUin: 2867977191,
    selfNickname: '樱良',
    accountOnline: true,
    qzone: { enabled: true, autoPublish: true, nextAutoCheckAt: Date.parse('2026-10-20T08:00:00+08:00'), postToday: 1, postMax: 1, imageToday: 1, imageMax: 1 },
    social: { enabled: true, nextCheckAt: Date.parse('2026-10-20T10:00:00+08:00'), likeToday: 2, likeMax: 8, commentToday: 1, commentMax: 3, followupToday: 0, followupMax: 2 },
    pendingComments: 2,
    conversations: 9,
    reminders: 3
  });
  assert.match(text, /【机器人状态】/);
  assert.match(text, /模式：reserved2｜运行：2天3小时/);
  assert.match(text, /樱良\(2867977191\)｜在线/);
  assert.match(text, /今日额度：发帖 1\/1/);
  assert.match(text, /待处理评论：2 条/);
});

test('会话/群/成员/错误/提醒格式化', () => {
  const conv = formatConversations([
    { key: 'private:7770486', unread: 2, recent: 100, lastIncomingAt: Date.parse('2026-10-20T00:12:00+08:00'), lastAiReplyAt: Date.parse('2026-10-20T00:13:00+08:00') }
  ]);
  assert.match(conv, /【会话列表】1 个/);
  assert.match(conv, /private:7770486（私聊）未读 2/);
  const groups = formatGroups([{ group_id: 7000001, group_name: '樱良、那年夏末、示例昵称、', member_count: 4 }]);
  assert.match(groups, /【群列表】1 个/);
  assert.match(groups, /樱良、那年夏末、示例昵称、\(7000001\)  4 人/);
  const members = formatGroupMembers(7000001, [{ user_id: 7770486, card: '示例好友甲', nickname: '示例好友甲' }]);
  assert.match(members, /【群成员】7000001｜1 人/);
  assert.match(members, /示例好友甲\(7770486\)/);
  const errors = formatRecentErrors([{ label: '空间互动', at: Date.parse('2026-10-19T22:45:00+08:00'), text: 'comment: timeout' }]);
  assert.match(errors, /【最近错误】/);
  assert.match(errors, /空间互动.*comment: timeout/);
  const rem = formatReminders([{ id: 'r_12345678', at: Date.parse('2026-10-20T09:00:00+08:00'), key: 'private:7770486', text: '出门走走', repeat: null }]);
  assert.match(rem, /【提醒列表】1 条/);
  assert.match(rem, /r_12345678/);
  assert.match(rem, /出门走走/);
  const bal = formatDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '27.45', granted_balance: '0.00', topped_up_balance: '27.45' }] });
  assert.match(bal, /【DeepSeek 余额】可用/);
  assert.match(bal, /总余额 ¥27\.45/);
  assert.match(bal, /充值 ¥27\.45/);
});

test('帮助文案包含全部控制台指令', () => {
  for (const s of ['[状态]', '[会话列表]', '[群列表]', '[群成员 7000001]', '[最近错误]', '[余额]', '[提醒列表]', '[取消提醒 r_xxxxxxxx]']) {
    assert.ok(CONSOLE_HELP.includes(s), s);
  }
});

console.log(`\n${passed} passed`);
