#!/usr/bin/env node
// 目标名匹配：纯函数测试。
import assert from 'node:assert/strict';
import {
  isTargetId, matchGroup, matchFriend, matchGroupMember, formatMatchFailure
} from '../src/target-resolve.js';

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

const groups = [
  { group_id: 200000001, group_name: '测试群聊' },
  { group_id: 200100001, group_name: '另一个群' },
  { group_id: 200100002, group_name: '重名群' },
  { group_id: 200100004, group_name: '重名群' }
];

const friends = [
  { user_id: 100000001, remark: '测试联系人', nickname: 'FixtureNick' },
  { user_id: 100100003, remark: '', nickname: '大肥鱼' },
  { user_id: 55555555, remark: '小明', nickname: 'XiaoMing' }
];

const members = [
  { user_id: 100000001, card: '测试联系人', nickname: 'FixtureNick', title: '话痨' },
  { user_id: 100100003, card: '大肥鱼', nickname: 'FixtureNick' },
  { user_id: 66666666, card: '', nickname: '小明', title: '摸鱼达人' }
];

test('号码识别：5~12 位', () => {
  assert.equal(isTargetId('200000001'), true);
  assert.equal(isTargetId('100000001'), true);
  assert.equal(isTargetId('123'), false);
  assert.equal(isTargetId('1100100004123'), false);
  assert.equal(isTargetId('测试群'), false);
});

test('群名：精确/子串/未找到', () => {
  assert.equal(matchGroup(groups, '测试群聊').id, '200000001');
  assert.equal(matchGroup(groups, '测试').id, '200000001');
  assert.equal(matchGroup(groups, '不存在的群').reason, 'not-found');
});

test('群名重名：拒绝并给候选', () => {
  const r = matchGroup(groups, '重名群');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.total, 2);
  assert.match(formatMatchFailure(r, '重名群', 'group'), /重名群（200100002）/);
  assert.match(formatMatchFailure(r, '重名群', 'group'), /改用群号/);
});

test('好友：备注优先、昵称也能匹配', () => {
  assert.equal(matchFriend(friends, '测试联系人').id, '100000001');
  assert.equal(matchFriend(friends, 'FixtureNick').id, '100000001');
  assert.equal(matchFriend(friends, '大肥鱼').id, '100100003');
  assert.equal(matchFriend(friends, '小明').id, '55555555');
  assert.equal(matchFriend(friends, '不存在').reason, 'not-found');
});

test('好友重名：拒绝并给候选', () => {
  const dup = matchFriend([
    { user_id: 11111111, remark: '小明', nickname: 'A' },
    { user_id: 22222222, remark: '小明', nickname: 'B' }
  ], '小明');
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'ambiguous');
  assert.equal(dup.total, 2);
  assert.match(formatMatchFailure(dup, '小明', 'friend'), /改用 QQ 号/);
});

test('好友：数字后几位匹配', () => {
  const r = matchFriend(friends, String(friends[0].user_id).slice(-6));
  assert.equal(r.ok, true);
  assert.equal(r.id, '100000001');
});

test('群成员：名片/昵称/头衔/QQ', () => {
  assert.equal(matchGroupMember(members, '测试联系人').id, '100000001');
  assert.equal(matchGroupMember(members, '大肥鱼').id, '100100003');
  assert.equal(matchGroupMember(members, '摸鱼达人').id, '66666666');
  assert.equal(matchGroupMember(members, '100000001').id, '100000001');
  // 「YNA」同时是两个人：拒绝。
  const dup = matchGroupMember(members, 'FixtureNick');
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'ambiguous');
  assert.equal(dup.total, 2);
});

test('失败提示区分群/好友/成员', () => {
  assert.match(formatMatchFailure({ reason: 'not-found' }, 'X', 'group'), /群列表/);
  assert.match(formatMatchFailure({ reason: 'not-found' }, 'X', 'friend'), /查看你全部好友/);
  assert.match(formatMatchFailure({ reason: 'not-found' }, 'X', 'member'), /群成员/);
});

console.log(`\ntarget-resolve tests: ${passed} passed`);
