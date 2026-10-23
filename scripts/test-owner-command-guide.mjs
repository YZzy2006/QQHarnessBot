#!/usr/bin/env node
// owner 指令输错/格式不对的提示与引导：纯函数测试。
import assert from 'node:assert/strict';
import {
  buildOwnerCommandGuide, looksLikeOwnerCommandAttempt,
  PROFILE_LIKE_GUIDE, FRIEND_REQUEST_GUIDE, FRIEND_VIEW_GUIDE,
  FEED_QUERY_GUIDE, GENERIC_GUIDE, PENDING_COMMENT_GUIDE, CONSOLE_GUIDE, GROUP_VIEW_GUIDE,
  ADMIN_GUIDE, OWNER_ACTION_GUIDE
} from '../src/owner-command-guide.js';

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

test('好友查看指令写错 → 好友查看引导', () => {
  assert.equal(buildOwnerCommandGuide('[查看你全部好友啊]'), FRIEND_VIEW_GUIDE);
  assert.equal(buildOwnerCommandGuide('[查看你最近最活跃的]'), FRIEND_VIEW_GUIDE);
  assert.equal(buildOwnerCommandGuide('[查看示例好友甲 20条对话]'), FRIEND_VIEW_GUIDE);
  assert.equal(buildOwnerCommandGuide('[查看你最近最活跃的好友5个]'), FRIEND_VIEW_GUIDE);
});

test('好友申请指令写错 → 好友申请引导', () => {
  assert.equal(buildOwnerCommandGuide('[通过申请]'), FRIEND_REQUEST_GUIDE);
  assert.equal(buildOwnerCommandGuide('[拒绝申请]'), FRIEND_REQUEST_GUIDE);
  assert.equal(buildOwnerCommandGuide('[好友来源]'), FRIEND_REQUEST_GUIDE);
});

test('资料卡点赞写错 → 资料卡引导；无法分类 → 通用引导', () => {
  assert.equal(buildOwnerCommandGuide('[资料卡点赞示例好友甲十次了]'), PROFILE_LIKE_GUIDE);
  assert.equal(buildOwnerCommandGuide('[资料卡]'), GENERIC_GUIDE);
});

test('群聊记录写错 → 群聊引导', () => {
  assert.equal(buildOwnerCommandGuide('[查看群聊啊]'), GROUP_VIEW_GUIDE);
  assert.equal(buildOwnerCommandGuide('[群聊记录啊]'), GROUP_VIEW_GUIDE);
});

test('管理指令写错 → 管理引导', () => {
  assert.equal(buildOwnerCommandGuide('[踢人啊]'), ADMIN_GUIDE);
  assert.equal(buildOwnerCommandGuide('[入群申请啊]'), ADMIN_GUIDE);
  assert.equal(buildOwnerCommandGuide('[查QQ啊]'), ADMIN_GUIDE);
  assert.equal(buildOwnerCommandGuide('[群头衔啊]'), ADMIN_GUIDE);
  assert.equal(buildOwnerCommandGuide('[设精华啊]'), ADMIN_GUIDE);
  assert.equal(buildOwnerCommandGuide('[取消精华啊]'), ADMIN_GUIDE);
  assert.equal(buildOwnerCommandGuide('[群签到啊]'), ADMIN_GUIDE);
});

test('主动/限额/定时写错 → 对应引导', () => {
  for (const text of ['[主动唤醒啊]', '[主动对话啊]', '[主动状态啊]', '[主动开关啊]', '[关闭主动啊]', '[限额调整啊]', '[限额重置啊]', '[定时任务啊]', '[查询模型余额啊]', '[消息表情回应啊]']) {
    assert.equal(buildOwnerCommandGuide(text), OWNER_ACTION_GUIDE, text);
  }
});

test('待处理评论/控制台写错 → 对应引导', () => {
  assert.equal(buildOwnerCommandGuide('[待评论确认啊]'), PENDING_COMMENT_GUIDE);
  assert.equal(buildOwnerCommandGuide('[查看待处理评论啊]'), PENDING_COMMENT_GUIDE);
  assert.equal(buildOwnerCommandGuide('[状态啊]'), CONSOLE_GUIDE);
  assert.equal(buildOwnerCommandGuide('[取消提醒]'), CONSOLE_GUIDE);
  assert.equal(buildOwnerCommandGuide('[群成员]'), CONSOLE_GUIDE);
  assert.equal(buildOwnerCommandGuide('[群荣誉啊]'), CONSOLE_GUIDE);
  assert.equal(buildOwnerCommandGuide('[@全体剩余啊]'), CONSOLE_GUIDE);
});

test('好友动态查询写错 → 动态查询引导', () => {
  assert.equal(buildOwnerCommandGuide('[查看好友动态啊]'), FEED_QUERY_GUIDE);
  assert.equal(buildOwnerCommandGuide('[查看示例好友甲的动态 最近]'), FEED_QUERY_GUIDE);
});

test('普通聊天不误判', () => {
  for (const text of [
    '查看了一下今天天气',
    '我今天加了个好友',
    '我[今天]和朋友吃饭',
    '[今天]和朋友吃饭',
    '推荐个资料卡背景',
    '你好',
    '晚安'
  ]) {
    assert.equal(looksLikeOwnerCommandAttempt(text), false, text);
    assert.equal(buildOwnerCommandGuide(text), '', text);
  }
});

test('引导文案都带正确示例和 [指令] 入口', () => {
  for (const text of [PROFILE_LIKE_GUIDE, FRIEND_REQUEST_GUIDE, FRIEND_VIEW_GUIDE, FEED_QUERY_GUIDE, GENERIC_GUIDE]) {
    assert.match(text, /【指令没听懂】/);
    assert.match(text, /\[指令\]/);
    assert.match(text, /\[/);
  }
  assert.match(FRIEND_VIEW_GUIDE, /\[查看你全部好友\]/);
  assert.match(FRIEND_REQUEST_GUIDE, /\[通过申请 1\]/);
  assert.match(PROFILE_LIKE_GUIDE, /\[资料卡点赞\] \[示例好友甲\] \[10\]/);
  assert.match(FEED_QUERY_GUIDE, /\[查看好友动态\] \[最近3天\] \[最多5条\]/);
});

console.log(`\n${passed} passed`);
