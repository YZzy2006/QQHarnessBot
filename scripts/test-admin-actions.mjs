#!/usr/bin/env node
// 管理指令：纯解析/帮助测试。无网络、无状态。
import assert from 'node:assert/strict';
import { parseAdminCommand, ADMIN_HELP } from '../src/admin-actions.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n   ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const G = 7000001;
const U = 7770486;

test('入群申请列表：三种叫法 + 无方括号', () => {
  for (const text of ['[入群申请]', '[入群请求]', '[加群申请]', '入群申请']) {
    assert.deepEqual(parseAdminCommand(text), { ok: true, action: 'groupRequests' }, text);
  }
});

test('通过/拒绝入群：序号或 flag', () => {
  const seq = parseAdminCommand('[通过入群 1]');
  assert.equal(seq.ok, true);
  assert.equal(seq.action, 'groupRequestApprove');
  assert.equal(seq.ref, '1');
  assert.equal(seq.seq, 1);

  const flag = parseAdminCommand('同意入群 fr_ab12cd');
  assert.equal(flag.action, 'groupRequestApprove');
  assert.equal(flag.ref, 'fr_ab12cd');
  assert.equal(flag.seq, 0);

  const reject = parseAdminCommand('[拒绝入群 2]');
  assert.equal(reject.action, 'groupRequestReject');
  assert.equal(reject.seq, 2);

  const bo = parseAdminCommand('[驳回入群 fr_ab12cd]');
  assert.equal(bo.action, 'groupRequestReject');
  assert.equal(bo.ref, 'fr_ab12cd');

  assert.deepEqual(parseAdminCommand('[通过入群]'), { ok: false, error: 'missing-args', action: 'groupRequestApprove' });
  assert.deepEqual(parseAdminCommand('[拒绝入群]'), { ok: false, error: 'missing-args', action: 'groupRequestReject' });
});

test('踢人：缺确认也 ok:true，但 confirmed:false', () => {
  assert.deepEqual(parseAdminCommand(`[踢人 ${G} ${U} 确认]`), { ok: true, action: 'kick', groupId: G, userId: U, confirmed: true });
  const without = parseAdminCommand(`[踢人] [${G}] [${U}]`);
  assert.equal(without.ok, true);
  assert.equal(without.confirmed, false);
  assert.deepEqual(parseAdminCommand('[踢人 7000001]'), { ok: false, error: 'missing-args', action: 'kick' });
});

test('群名/好友名：分段写法保留空格', () => {
  const kick = parseAdminCommand('[踢人][测试 群聊][示例好友甲][确认]');
  assert.equal(kick.ok, true);
  assert.equal(kick.groupText, '测试 群聊');
  assert.equal(kick.userText, '示例好友甲');
  assert.equal(kick.confirmed, true);

  const sign = parseAdminCommand('[群签到][测试群聊]');
  assert.equal(sign.ok, true);
  assert.equal(sign.groupText, '测试群聊');

  const del = parseAdminCommand('[删好友][示例好友甲][确认]');
  assert.equal(del.ok, true);
  assert.equal(del.userText, '示例好友甲');
  assert.equal(del.confirmed, true);

  const title = parseAdminCommand('[群头衔][测试群聊][示例好友甲][摸鱼达人][确认]');
  assert.equal(title.groupText, '测试群聊');
  assert.equal(title.userText, '示例好友甲');
  assert.equal(title.title, '摸鱼达人');
});

test('禁言：缺分钟默认 10，显式分钟为数字，确认可选', () => {
  const def = parseAdminCommand(`[禁言] [${G}] [${U}]`);
  assert.equal(def.ok, true);
  assert.equal(def.minutes, 10);
  assert.equal(typeof def.minutes, 'number');
  assert.equal(def.confirmed, false);
  assert.equal(parseAdminCommand(`[禁言 ${G} ${U} 30]`).minutes, 30);
  assert.equal(parseAdminCommand(`[禁言 ${G} ${U} 30 确认]`).confirmed, true);
  assert.equal(parseAdminCommand(`[禁言 ${G} ${U} 确认]`).minutes, 10);
  assert.equal(parseAdminCommand(`[禁言 ${G} ${U} 确认]`).confirmed, true);
  assert.equal(parseAdminCommand(`[禁言 ${G}]`).error, 'missing-args');
});

test('解禁 / 全员禁言', () => {
  assert.deepEqual(parseAdminCommand(`[解禁 ${G} ${U}]`), { ok: true, action: 'unban', groupId: G, userId: U });
  assert.equal(parseAdminCommand(`[解禁 ${G}]`).error, 'missing-args');

  assert.deepEqual(parseAdminCommand(`[全员禁言 ${G} on]`), { ok: true, action: 'wholeBan', groupId: G, enable: true, confirmed: false });
  assert.deepEqual(parseAdminCommand(`[全员禁言 ${G} off]`), { ok: true, action: 'wholeBan', groupId: G, enable: false, confirmed: false });
  assert.equal(parseAdminCommand(`[全员禁言 ${G} on 确认]`).confirmed, true);
  assert.equal(parseAdminCommand(`[全员禁言 ${G} 开]`).enable, true);
  assert.equal(parseAdminCommand('[全员禁言]').error, 'missing-args');
  assert.equal(parseAdminCommand(`[全员禁言 ${G}]`).error, 'missing-args');
  assert.equal(parseAdminCommand(`[全员禁言 ${G} maybe]`).error, 'invalid-args');
});

test('改名片/改群名：文本参数取剩余全部内容（含空格）', () => {
  const card = parseAdminCommand(`[改名片] [${G}] [${U}] [雨 中 之 约]`);
  assert.deepEqual(card, { ok: true, action: 'setCard', groupId: G, userId: U, card: '雨 中 之 约', confirmed: false });
  assert.equal(parseAdminCommand(`改名片 ${G} ${U} 示例好友甲`).card, '示例好友甲');
  assert.equal(parseAdminCommand(`[改名片 ${G} ${U} 雨 中 之 约 确认]`).card, '雨 中 之 约');
  assert.equal(parseAdminCommand(`[改名片 ${G} ${U} 雨 中 之 约 确认]`).confirmed, true);

  const name = parseAdminCommand(`[改群名 ${G} 樱良 那年夏末]`);
  assert.deepEqual(name, { ok: true, action: 'setGroupName', groupId: G, name: '樱良 那年夏末', confirmed: false });
  assert.equal(parseAdminCommand(`[改群名 ${G} 樱良 那年夏末 确认]`).name, '樱良 那年夏末');
  assert.equal(parseAdminCommand(`[改群名 ${G} 樱良 那年夏末 确认]`).confirmed, true);

  assert.equal(parseAdminCommand(`[改名片 ${G} ${U}]`).error, 'missing-args');
  assert.equal(parseAdminCommand(`[改群名 ${G}]`).error, 'missing-args');
});

test('设管理：on/off', () => {
  assert.deepEqual(parseAdminCommand(`[设管理 ${G} ${U} on]`), { ok: true, action: 'setAdmin', groupId: G, userId: U, enable: true, confirmed: false });
  assert.equal(parseAdminCommand(`[设管理 ${G} ${U} off]`).enable, false);
  assert.equal(parseAdminCommand(`[设管理 ${G} ${U} on 确认]`).confirmed, true);
  assert.equal(parseAdminCommand(`[设管理 ${G} ${U}]`).error, 'missing-args');
  assert.equal(parseAdminCommand(`[设管理 ${G}]`).error, 'missing-args');
});

test('群头衔：头衔取剩余全部内容，需确认', () => {
  assert.deepEqual(parseAdminCommand(`[群头衔 ${G} ${U} 摸 鱼 达 人]`), {
    ok: true, action: 'setTitle', groupId: G, userId: U, title: '摸 鱼 达 人', confirmed: false
  });
  const confirmed = parseAdminCommand(`[群头衔 ${G} ${U} 摸鱼达人 确认]`);
  assert.equal(confirmed.title, '摸鱼达人');
  assert.equal(confirmed.confirmed, true);
  assert.equal(parseAdminCommand(`[设置头衔 ${G} ${U} 头衔]`).action, 'setTitle');
  assert.equal(parseAdminCommand(`[群头衔 ${G} ${U}]`).error, 'missing-args');
  assert.equal(parseAdminCommand(`[群头衔 ${G}]`).error, 'missing-args');
});

test('设精华 / 取消精华：message_id 支持负数，需确认', () => {
  assert.deepEqual(parseAdminCommand('[设精华 -123456789]'), {
    ok: true, action: 'setEssence', messageId: -123456789, confirmed: false
  });
  assert.equal(parseAdminCommand('[设精华 987654321 确认]').confirmed, true);
  assert.equal(parseAdminCommand('[设置精华 987654321]').action, 'setEssence');
  assert.equal(parseAdminCommand('[加精 987654321]').action, 'setEssence');
  assert.deepEqual(parseAdminCommand('[取消精华 -123456789]'), {
    ok: true, action: 'deleteEssence', messageId: -123456789, confirmed: false
  });
  assert.equal(parseAdminCommand('[移出精华 987654321 确认]').confirmed, true);
  assert.equal(parseAdminCommand('[取消加精 987654321]').action, 'deleteEssence');
  assert.equal(parseAdminCommand('[设精华 abc]').error, 'missing-args');
  assert.equal(parseAdminCommand('[取消精华]').error, 'missing-args');
});

test('群签到：群号必填，不需要确认', () => {
  assert.deepEqual(parseAdminCommand(`[群签到 ${G}]`), { ok: true, action: 'groupSign', groupId: G });
  assert.equal(parseAdminCommand('[群签到]').error, 'missing-args');
  assert.equal(parseAdminCommand('[群签到 123]').error, 'missing-args');
});

test('退群：确认布尔', () => {
  assert.deepEqual(parseAdminCommand(`[退群 ${G} 确认]`), { ok: true, action: 'leaveGroup', groupId: G, confirmed: true });
  assert.equal(parseAdminCommand(`[退群 ${G}]`).confirmed, false);
  assert.equal(parseAdminCommand('[退群]').error, 'missing-args');
});

test('撤回：message_id 支持负数，确认可选', () => {
  assert.deepEqual(parseAdminCommand('[撤回 -123456789]'), { ok: true, action: 'recall', messageId: -123456789, confirmed: false });
  assert.deepEqual(parseAdminCommand('[撤回 987654321]'), { ok: true, action: 'recall', messageId: 987654321, confirmed: false });
  assert.equal(parseAdminCommand('[撤回 987654321 确认]').confirmed, true);
  assert.equal(parseAdminCommand('[撤回]').error, 'missing-args');
  assert.equal(parseAdminCommand('[撤回 abc]').error, 'missing-args');
});

test('查QQ / 改备注 / 删好友', () => {
  assert.deepEqual(parseAdminCommand(`[查QQ ${U}]`), { ok: true, action: 'strangerInfo', userId: U });
  assert.deepEqual(parseAdminCommand(`查qq ${U}`), { ok: true, action: 'strangerInfo', userId: U });
  assert.equal(parseAdminCommand('[查QQ]').error, 'missing-args');

  assert.deepEqual(parseAdminCommand(`[改备注 ${U} 老 同 学]`), { ok: true, action: 'setFriendRemark', userId: U, remark: '老 同 学' });
  assert.equal(parseAdminCommand(`[改备注 ${U}]`).error, 'missing-args');

  assert.deepEqual(parseAdminCommand(`[删好友 ${U} 确认]`), { ok: true, action: 'deleteFriend', userId: U, confirmed: true });
  assert.equal(parseAdminCommand(`[删好友 ${U}]`).confirmed, false);
  assert.equal(parseAdminCommand('[删好友]').error, 'missing-args');
});

test('帮助：三种叫法', () => {
  for (const text of ['[管理帮助]', '[管理员帮助]', '[管理指令]']) {
    assert.deepEqual(parseAdminCommand(text), { ok: true, action: 'help' }, text);
  }
});

test('普通聊天不拦截', () => {
  const chats = ['你好', '今天禁言了吗', '撤回了一条消息吗', '我们退群吧', '帮我踢人', '查一下 QQ', '签到', '精华', '今天头衔不错', '', null, undefined, 123];
  for (const text of chats) {
    assert.equal(parseAdminCommand(text).ok, false, String(text));
  }
});

test('不抛异常：畸形输入', () => {
  const bad = ['[', ']', '[]', '[踢人 、 、]', '[禁言 0 0 abc]', '[改名片 a b]', '【退群 7000001 确认】', '[撤回 --1]', '[全员禁言 7000001 1]'];
  for (const text of bad) {
    assert.doesNotThrow(() => parseAdminCommand(text), text);
    assert.equal(typeof parseAdminCommand(text).ok, 'boolean');
  }
});

test('ADMIN_HELP 覆盖全部指令、例子、确认与加好友说明', () => {
  const must = [
    '入群申请', '入群请求', '加群申请', '通过入群', '同意入群', '拒绝入群', '驳回入群',
    '踢人', '禁言', '解禁', '全员禁言', '改名片', '改群名', '设管理', '群头衔',
    '设精华', '取消精华', '群签到', '退群', '撤回',
    '查QQ', '改备注', '删好友', '管理帮助', '管理员帮助', '管理指令'
  ];
  for (const word of must) assert.ok(ADMIN_HELP.includes(word), word);

  const examples = [
    `[踢人 ${G} ${U} 确认]`,
    `[禁言 ${G} ${U} 30 确认]`,
    `[改名片 ${G} ${U} 新名片 可以带空格 确认]`,
    `[改群名 ${G} 新的群名 可以带空格 确认]`,
    `[群头衔 ${G} ${U} 头衔 确认]`,
    '[撤回 -123456789 确认]',
    '[设精华 -123456789 确认]',
    '[取消精华 -123456789 确认]',
    `[群签到 ${G}]`,
    `[改备注 ${U} 老同学 可以带空格]`,
    `[删好友 ${U} 确认]`,
    `[退群 ${G} 确认]`
  ];
  for (const example of examples) assert.ok(ADMIN_HELP.includes(example), example);

  assert.ok(ADMIN_HELP.includes('危险：必须带“确认”'));
  assert.ok(ADMIN_HELP.includes('主动加好友当前不支持'));
  assert.ok(ADMIN_HELP.includes('方括号可加可不加'));
});

console.log(`\n${passed} passed`);
