#!/usr/bin/env node
// owner 主动/限额/定时/表情回应指令：纯解析/格式化测试。
import assert from 'node:assert/strict';
import {
  parseOwnerActionCommand,
  formatOwnerActionUsage,
  formatEmojiLikeResult,
  formatWakeResult,
  formatTalkResult,
  formatLimitStatus,
  formatLimitChange,
  formatLimitReset,
  formatScheduleResult, formatScheduleList, formatScheduleCancel, formatScheduleCandidates,
  formatModelBalanceList, formatProactiveStatus, formatProactiveToggle
} from '../src/owner-actions.js';

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

test('消息表情回应：设置/取消，分段与空格写法', () => {
  assert.deepEqual(parseOwnerActionCommand('[消息表情回应][-123456789][76]'), {
    ok: true, action: 'emojiLike', messageId: -123456789, emojiId: '76', set: true
  });
  assert.deepEqual(parseOwnerActionCommand('[取消表情回应 987654321 76]'), {
    ok: true, action: 'emojiLike', messageId: 987654321, emojiId: '76', set: false
  });
  assert.equal(parseOwnerActionCommand('[消息表情回应][abc][76]').error, 'invalid-args');
  assert.equal(parseOwnerActionCommand('[消息表情回应][123]').error, 'invalid-args');
});

test('主动唤醒：目标可带空格', () => {
  assert.deepEqual(parseOwnerActionCommand('[主动唤醒][测试 群聊]'), {
    ok: true, action: 'wake', target: '测试 群聊'
  });
  assert.deepEqual(parseOwnerActionCommand('主动唤醒 示例好友甲'), {
    ok: true, action: 'wake', target: '示例好友甲'
  });
  assert.equal(parseOwnerActionCommand('[主动唤醒]').error, 'missing-args');
});

test('主动对话：目标 + 内容（内容可带空格）', () => {
  assert.deepEqual(parseOwnerActionCommand('[主动对话][测试群聊][说一句 晚安]'), {
    ok: true, action: 'talk', target: '测试群聊', content: '说一句 晚安'
  });
  assert.deepEqual(parseOwnerActionCommand('主动对话 示例好友甲 给我 说早安'), {
    ok: true, action: 'talk', target: '示例好友甲', content: '给我 说早安'
  });
  assert.equal(parseOwnerActionCommand('[主动对话][示例好友甲]').error, 'missing-args');
  assert.equal(parseOwnerActionCommand(`[主动对话][示例好友甲][${'长'.repeat(501)}]`).error, 'content-too-long');
});

test('主动问候：状态/开关/简写', () => {
  assert.deepEqual(parseOwnerActionCommand('[主动状态][示例好友甲]'), {
    ok: true, action: 'proactiveStatus', target: '示例好友甲'
  });
  assert.deepEqual(parseOwnerActionCommand('[主动开关][示例好友甲][off]'), {
    ok: true, action: 'proactiveToggle', target: '示例好友甲', enabled: false
  });
  assert.deepEqual(parseOwnerActionCommand('[主动开关 测试群聊 on]'), {
    ok: true, action: 'proactiveToggle', target: '测试群聊', enabled: true
  });
  assert.deepEqual(parseOwnerActionCommand('[关闭主动][示例好友甲]'), {
    ok: true, action: 'proactiveToggle', target: '示例好友甲', enabled: false
  });
  assert.deepEqual(parseOwnerActionCommand('[开启主动][示例好友甲]'), {
    ok: true, action: 'proactiveToggle', target: '示例好友甲', enabled: true
  });
  // 不带 on/off = 查看状态
  assert.deepEqual(parseOwnerActionCommand('[主动开关][示例好友甲]'), {
    ok: true, action: 'proactiveStatus', target: '示例好友甲'
  });
  assert.equal(parseOwnerActionCommand('[主动开关][示例好友甲][maybe]').error, 'invalid-mode');
  assert.equal(parseOwnerActionCommand('[主动状态]').error, 'missing-args');
});

test('主动问候：状态/开关格式化', () => {
  const status = formatProactiveStatus({
    target: '示例好友甲（私聊 7770486）',
    enabled: true,
    lastText: '2026-10-21 10:00',
    ageText: '2 小时前',
    maxIdleDays: 3,
    blockReason: ''
  });
  assert.match(status, /【主动问候】/);
  assert.match(status, /开关：开启/);
  assert.match(status, /当前状态：正常/);

  const stale = formatProactiveStatus({
    target: 'X', enabled: true, maxIdleDays: 3, blockReason: 'stale:3'
  });
  assert.match(stale, /已暂停（超过 3 天没对话）/);

  assert.match(formatProactiveToggle({ target: 'X', enabled: false }), /已关闭/);
  assert.match(formatProactiveToggle({ target: 'X', enabled: true, blockReason: 'stale:3', maxIdleDays: 3 }), /仍会自动暂停/);
});

test('限额调整：查看/单档/三档', () => {
  assert.deepEqual(parseOwnerActionCommand('[限额调整]'), { ok: true, action: 'limitStatus' });
  assert.deepEqual(parseOwnerActionCommand('[限额调整][私聊]'), { ok: true, action: 'limitStatus', scope: 'private' });
  assert.deepEqual(parseOwnerActionCommand('[限额调整][私聊][每分钟][20]'), {
    ok: true, action: 'limitAdjust', scope: 'private', window: 'minute', value: 20
  });
  assert.deepEqual(parseOwnerActionCommand('[限额调整][群聊][小时][200]'), {
    ok: true, action: 'limitAdjust', scope: 'group', window: 'hour', value: 200
  });
  assert.deepEqual(parseOwnerActionCommand('[限额调整][群聊][每天][0]'), {
    ok: true, action: 'limitAdjust', scope: 'group', window: 'day', value: 0
  });
  assert.deepEqual(parseOwnerActionCommand('[限额调整][私聊][20/200/500]'), {
    ok: true, action: 'limitAdjustAll', scope: 'private', minute: 20, hour: 200, day: 500
  });
  assert.equal(parseOwnerActionCommand('[限额调整][家庭][每分钟][20]').error, 'invalid-scope');
  assert.equal(parseOwnerActionCommand('[限额调整][私聊][每分钟][abc]').error, 'invalid-value');
});

test('限额重置', () => {
  assert.deepEqual(parseOwnerActionCommand('[限额重置][示例好友甲]'), {
    ok: true, action: 'limitReset', target: '示例好友甲'
  });
  assert.equal(parseOwnerActionCommand('[限额重置]').error, 'missing-args');
});

test('定时任务：时间/目标/内容', () => {
  assert.deepEqual(parseOwnerActionCommand('[定时任务][明天早上][示例好友甲][给我用语音打招呼说早安]'), {
    ok: true, action: 'schedule', timeText: '明天早上', target: '示例好友甲', content: '给我用语音打招呼说早安'
  });
  assert.deepEqual(parseOwnerActionCommand('定时任务 2小时后 测试群聊 分享昨天的大事件'), {
    ok: true, action: 'schedule', timeText: '2小时后', target: '测试群聊', content: '分享昨天的大事件'
  });
  assert.equal(parseOwnerActionCommand('[定时任务][明天早上][示例好友甲]').error, 'missing-args');
});

test('定时任务：查看所有 / 取消 / 帮助', () => {
  assert.deepEqual(parseOwnerActionCommand('[定时任务]'), { ok: true, action: 'scheduleList' });
  assert.deepEqual(parseOwnerActionCommand('[定时任务][查看所有]'), { ok: true, action: 'scheduleList' });
  assert.deepEqual(parseOwnerActionCommand('[定时任务][列表]'), { ok: true, action: 'scheduleList' });
  assert.deepEqual(parseOwnerActionCommand('[定时任务][帮助]'), { ok: true, action: 'scheduleHelp' });
  assert.deepEqual(parseOwnerActionCommand('[定时任务][取消][1]'), { ok: true, action: 'scheduleCancel', ref: '1', confirmed: false });
  assert.deepEqual(parseOwnerActionCommand('[定时任务][取消][r_ab12cd34]'), { ok: true, action: 'scheduleCancel', ref: 'r_ab12cd34', confirmed: false });
  assert.deepEqual(parseOwnerActionCommand('[定时任务][取消][全部][确认]'), { ok: true, action: 'scheduleCancel', ref: '全部', confirmed: true });
  assert.equal(parseOwnerActionCommand('[定时任务][取消]').error, 'missing-args');
});

test('定时任务：次数/截止/永久条件', () => {
  assert.deepEqual(parseOwnerActionCommand('[定时任务][每天8点][示例好友甲][说早安][连续7天]'), {
    ok: true, action: 'schedule', timeText: '每天8点', target: '示例好友甲', content: '说早安', remaining: 7
  });
  assert.equal(parseOwnerActionCommand('[定时任务][每天8点][示例好友甲][说早安][共10次]').remaining, 10);
  assert.equal(parseOwnerActionCommand('[定时任务][每天8点][示例好友甲][说早安][10次]').remaining, 10);
  assert.equal(parseOwnerActionCommand('[定时任务][每天8点][示例好友甲][说早安][到2026-10-28]').endText, '到2026-10-28');
  const forever = parseOwnerActionCommand('[定时任务][每天8点][示例好友甲][说早安][永久]');
  assert.equal(forever.ok, true);
  assert.equal('remaining' in forever, false);
  assert.equal('endText' in forever, false);
  // 正文里的「7天」不能当成条件。
  const content = parseOwnerActionCommand('[定时任务][每天8点][示例好友甲][连续7天都提醒我]');
  assert.equal(content.content, '连续7天都提醒我');
  assert.equal('remaining' in content, false);
});

test('定时任务格式化：列表/取消/候选', () => {
  const list = formatScheduleList({ items: [
    { id: 'r_1', atText: '2026-10-22 08:00', ruleText: '每天 08:00', repeatText: '每天', remaining: 7, target: '示例好友甲', content: '说早安' },
    { id: 'r_2', atText: '2026-10-22 08:00', repeatText: '一次性', target: '测试群聊', content: '提醒一下' }
  ] });
  assert.match(list, /【定时任务】2 条/);
  assert.match(list, /r_1｜每天 08:00｜下次 2026-10-22 08:00｜剩 7 次/);
  assert.match(list, /r_2｜2026-10-22 08:00｜→ 测试群聊/);
  assert.match(list, /取消 序号/);

  assert.equal(formatScheduleList({ items: [] }).includes('当前没有定时任务'), true);
  assert.match(formatScheduleCancel({ id: 'r_1', atText: '每天 08:00', target: '示例好友甲' }), /已取消定时任务 r_1/);
  assert.match(formatScheduleCancel({ all: true, count: 3 }), /全部 3 条/);
  assert.match(formatScheduleCandidates({ ref: '早安', candidates: [
    { id: 'r_1', atText: '每天 08:00', target: '示例好友甲', content: '说早安' }
  ] }), /匹配到 1 条/);
  assert.match(formatScheduleResult({ id: 'r_1', atText: '每天 08:00', target: 'X', content: '说早安', repeatText: '每天', remaining: 7 }), /共 7 次/);
  assert.match(formatScheduleResult({ id: 'r_1', atText: '每天 08:00', target: 'X', content: '说早安', repeatText: '每天' }), /长期，直到取消/);
});

test('查询模型余额：全部供应商与未知', () => {
  assert.deepEqual(parseOwnerActionCommand('[查询模型余额]'), { ok: true, action: 'modelBalanceList' });
  assert.deepEqual(parseOwnerActionCommand('[查询模型余额][deepseek]'), {
    ok: true, action: 'modelBalance', provider: 'deepseek', raw: 'deepseek'
  });
  assert.deepEqual(parseOwnerActionCommand('[查询模型余额][千问]'), {
    ok: true, action: 'modelBalance', provider: 'qwen', raw: '千问'
  });
  assert.deepEqual(parseOwnerActionCommand('[查询模型余额][豆包]').provider, 'doubao');
  assert.deepEqual(parseOwnerActionCommand('[查询模型余额][小米]').provider, 'xiaomi');
  assert.equal(parseOwnerActionCommand('[查询模型余额][未知模型]').provider, '');
});

test('普通聊天不拦截', () => {
  for (const text of ['你好', '主动一点', '限额是什么意思', '定时任务真麻烦', '查询余额', '', null, undefined, 123]) {
    assert.equal(parseOwnerActionCommand(text).ok, false, String(text));
  }
});

test('格式化输出', () => {
  assert.match(formatEmojiLikeResult({ messageId: -1, emojiId: '76', set: true }), /已给消息 -1/);
  assert.match(formatEmojiLikeResult({ messageId: -1, emojiId: '76', set: false }), /已取消消息 -1/);
  assert.match(formatEmojiLikeResult({ ok: false, error: '权限不足' }), /权限不足/);
  assert.match(formatWakeResult({ target: '测试群（群 1）' }), /已唤醒/);
  assert.match(formatWakeResult({ target: 'X', ok: false, queued: true }), /排队/);
  assert.match(formatTalkResult({ target: 'X' }), /主动开口/);
  assert.match(formatLimitStatus({ privateLimits: { perMinute: 10, perHour: 120, perDay: 500 }, groupLimits: { perMinute: 20, perHour: 200, perDay: 800 } }), /私聊：每分钟 10/);
  assert.match(formatLimitChange({ scope: 'private', window: 'minute', value: 20 }), /私聊限额的每分钟改为 20/);
  assert.match(formatLimitChange({ scope: 'group', all: true, minute: 20, hour: 200, day: 500 }), /每分钟 20/);
  assert.match(formatLimitReset({ target: '群 1', removed: 3 }), /移除 3 条/);
  assert.match(formatScheduleResult({ id: 'r_abc', atText: '2026-10-22 08:00', target: 'X', content: '说早安' }), /r_abc/);
  assert.match(formatModelBalanceList({ deepseekConfigured: true }), /DeepSeek：已配置/);
  assert.match(formatOwnerActionUsage({ action: 'schedule' }), /定时任务/);
});

console.log(`\nowner-actions tests: ${passed} passed`);
