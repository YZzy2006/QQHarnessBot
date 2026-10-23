#!/usr/bin/env node
// 白名单管理指令：纯解析/格式化测试。无网络、无状态。
import assert from 'node:assert/strict';
import {
  parseWhitelistCommand,
  formatWhitelistList,
  formatWhitelistChange,
  WHITELIST_HELP
} from '../src/whitelist-commands.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

test('解析：查看私聊/群聊/全部/帮助', () => {
  assert.deepEqual(parseWhitelistCommand('[私聊白名单]'), { ok: true, action: 'list', kind: 'private', ids: [], invalid: [], raw: '私聊白名单' });
  assert.deepEqual(parseWhitelistCommand('私聊白名单管理').action, 'list');
  assert.deepEqual(parseWhitelistCommand('私聊白名单列表').kind, 'private');
  assert.deepEqual(parseWhitelistCommand('[群聊白名单]').kind, 'groups');
  assert.deepEqual(parseWhitelistCommand('[白名单]').kind, 'all');
  assert.equal(parseWhitelistCommand('[白名单帮助]').action, 'help');
  assert.equal(parseWhitelistCommand('[私聊白名单帮助]').kind, 'private');
  assert.equal(parseWhitelistCommand('[群聊白名单管理帮助]').kind, 'groups');
});

test('解析：添加/删除/设置/清空，多 id 与空格逗号', () => {
  const add = parseWhitelistCommand('[私聊白名单 添加 123456，654321 111111]');
  assert.equal(add.action, 'add');
  assert.equal(add.kind, 'private');
  assert.deepEqual(add.ids, [123456, 654321, 111111]);
  assert.deepEqual(add.invalid, []);

  const del = parseWhitelistCommand('群聊白名单 删除 7000001、7000002');
  assert.equal(del.action, 'remove');
  assert.equal(del.kind, 'groups');
  assert.deepEqual(del.ids, [7000001, 7000002]);

  const set = parseWhitelistCommand('[私聊白名单 设置 123456 654321]');
  assert.equal(set.action, 'set');
  assert.deepEqual(set.ids, [123456, 654321]);
  assert.equal(set.confirmed, undefined);

  const setConfirmed = parseWhitelistCommand('[私聊白名单 设置 123456 654321 确认]');
  assert.equal(setConfirmed.confirmed, true);
  assert.deepEqual(setConfirmed.ids, [123456, 654321]);

  const clear = parseWhitelistCommand('[群聊白名单 清空]');
  assert.equal(clear.action, 'set');
  assert.deepEqual(clear.ids, []);
  assert.equal(clear.confirmed, undefined);
  assert.equal(parseWhitelistCommand('[群聊白名单 清空 确认]').confirmed, true);
});

test('解析：非法 id 与缺参', () => {
  const bad = parseWhitelistCommand('[私聊白名单 添加 123456 abc 1234567890123]');
  assert.equal(bad.action, 'add');
  assert.deepEqual(bad.ids, [123456]);
  assert.deepEqual(bad.invalid, ['abc', '1234567890123']);
  const missing = parseWhitelistCommand('[私聊白名单 添加]');
  assert.equal(missing.action, 'add');
  assert.deepEqual(missing.ids, []);
});

test('解析：普通聊天不误判', () => {
  for (const text of ['白名单是什么', '你好', '', null, '私聊白名单里有谁啊']) {
    assert.equal(parseWhitelistCommand(text).ok, false, String(text));
  }
  // 看起来像白名单但没有动作词：返回 unknown，让 handler 显示帮助。
  assert.equal(parseWhitelistCommand('[私聊白名单 123456]').action, 'unknown');
});

test('列表：私聊带名称、好友未加入、管理员警告、截断', () => {
  const text = formatWhitelistList({
    kind: 'private',
    ids: [7770486, 123],
    ownerQQ: 999,
    labels: { 7770486: '示例好友甲', 123: '测试' },
    candidates: [{ id: 55555, label: '新朋友' }],
    limit: 1
  });
  assert.match(text, /【私聊白名单】2 个/);
  assert.match(text, /测试\(123\)/);
  assert.match(text, /…还有 1 个/);
  assert.match(text, /管理员 999 不在白名单/);
  assert.match(text, /【好友未加入】1 个/);
  assert.match(text, /新朋友\(55555\)/);
  assert.match(text, /\[私聊白名单 添加 55555\]/);
});

test('列表：群聊未加入、全部摘要', () => {
  const text = formatWhitelistList({
    kind: 'groups',
    ids: [7000001],
    labels: { 7000001: '测试群聊' },
    candidates: [{ id: 7000002, label: '另一个群' }]
  });
  assert.match(text, /【群聊白名单】1 个/);
  assert.match(text, /测试群聊\(7000001\)/);
  assert.match(text, /【已在群里但未加入】1 个/);
  assert.match(text, /另一个群\(7000002\)/);

  const all = formatWhitelistList({ kind: 'all', privateIds: [1, 2], groupIds: [3] });
  assert.match(all, /私聊 2 个｜群聊 1 个/);
});

test('变更结果：添加/删除/跳过', () => {
  const add = formatWhitelistChange({ kind: 'private', action: 'add', changed: [123456], skipped: [654321], total: 10 });
  assert.match(add, /【私聊白名单】已添加 1 个/);
  assert.match(add, /123456/);
  assert.match(add, /已在白名单，跳过：654321/);
  assert.match(add, /当前 10 个/);

  const del = formatWhitelistChange({ kind: 'groups', action: 'remove', changed: [7000001], skipped: [], total: 0 });
  assert.match(del, /【群聊白名单】已移除 1 个/);
  assert.match(del, /当前 0 个/);
});

test('帮助文案覆盖全部动作', () => {
  for (const s of ['[私聊白名单]', '[私聊白名单 添加', '[私聊白名单 删除', '[私聊白名单 设置', '[群聊白名单]', '[群聊白名单 添加', '[白名单帮助]']) {
    assert.ok(WHITELIST_HELP.includes(s), s);
  }
});

console.log(`\nwhitelist tests: ${passed} passed`);
