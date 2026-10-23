#!/usr/bin/env node
// owner 只读查看指令：VM harness 集成测试（不碰真 QQ/DSH/网络）。
// 验证 bridge.js 的路由、SnowLuma 调用参数与最终回复；纯格式化细节见 test-owner-inspect.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OWNER = 123;
const GROUP = 7000001;
const STRANGER = 7770486;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const bridge = await bridgeHarness({
  config: {
    consolePort: 0,
    allow: { private: [String(OWNER)], groups: [String(GROUP)] }
  }
});
const { calls, temp } = bridge;

async function cmd(text) {
  bridge.setMode('reserved2');
  calls.sent.length = 0;
  await bridge.handleIncoming('private', OWNER, {
    user_id: OWNER,
    self_id: 1,
    message_id: String(Date.now()),
    message: [{ type: 'text', data: { text } }],
    raw_message: text
  }, bridge.cfg);
  return calls.sent.map((m) => m.text).join('\n');
}

await test('查看帮助：回复只读指令用法', async () => {
  const reply = await cmd('[查看帮助]');
  assert.match(reply, /【查看 · 用法】/);
  assert.match(reply, /今日用量/);
  assert.match(reply, /群荣誉/);
  assert.match(reply, /@全体剩余/);
  assert.match(reply, /标记已读/);
});

await test('今日用量：只算当天 turn，不把 base 的累计算进来', async () => {
  const usageFile = path.join(temp, 'state', 'token-usage.jsonl');
  fs.writeFileSync(usageFile, [
    JSON.stringify({ k: 'turn', t: Date.now(), sid: 's1', turn: 1, step: 1, model: 'deepseek-flash', key: 'private:123', b: { cacheMiss: 1000, output: 1000 } }),
    // base 是整条会话的历史累计：如果被算进今日，金额会直接爆掉。
    JSON.stringify({ k: 'base', t: Date.now(), sid: 's1', seq: 99, model: 'deepseek-flash', key: 'private:123', b: { cacheMiss: 9000000, output: 9000000 } })
  ].join('\n') + '\n', 'utf8');

  const reply = await cmd('[今日用量]');
  assert.match(reply, /【今日用量】/);
  assert.match(reply, /总 token：2,000/);
  assert.doesNotMatch(reply, /18,000,000/);
  assert.match(reply, /private:123/);
});

await test('服务器：输出负载/内存/运行时长', async () => {
  const reply = await cmd('[服务器]');
  assert.match(reply, /【服务器】/);
  assert.match(reply, /负载：/);
  assert.match(reply, /内存：/);
  assert.match(reply, /桥接运行时长：0天0小时2分/);
});

await test('群信息：调用 get_group_info 并格式化', async () => {
  calls.groupInfo = null;
  const reply = await cmd(`[群信息 ${GROUP}]`);
  assert.match(reply, new RegExp(`【群信息】${GROUP}`));
  assert.match(reply, /群名称：fixture-group/);
  assert.match(reply, /成员：4 \/ 200/);
  assert.match(reply, /群主：123/);
  assert.match(reply, /创建时间：2020-01-02 01:33/);
  assert.match(reply, /全员禁言：关闭/);
});

await test('群公告：调用 _get_group_notice 并列出公告', async () => {
  calls.groupNotices = [{
    publisher_id: 10001,
    publish_time: Math.floor(Date.now() / 1000),
    notice_type: '群公告',
    message: { text: '今晚维护', images: [{ file: 'a.png' }] }
  }];
  const reply = await cmd(`[群公告 ${GROUP}]`);
  assert.match(reply, new RegExp(`【群公告】${GROUP}`));
  assert.match(reply, /今晚维护/);
  assert.match(reply, /图片 1 张/);
});

await test('群荣誉：调用 get_group_honor_info（type=all）并格式化', async () => {
  calls.honorReads.length = 0;
  calls.honors = {
    current_talkative: { user_id: 10001, nickname: '龙王甲', description: '连续 7 天' },
    talkative_list: [
      { user_id: 10001, nickname: '龙王甲', description: '连续 7 天' },
      { user_id: 10002, nickname: '龙王乙', description: '连续 3 天' }
    ],
    performer_list: [{ user_id: 10003, nickname: '小火', description: '群聊之火' }],
    legend_list: [],
    emotion_list: [],
    strong_newbie_list: []
  };
  const reply = await cmd(`[群荣誉 ${GROUP}]`);
  assert.match(reply, new RegExp(`【群荣誉】${GROUP}`));
  assert.match(reply, /当前龙王：龙王甲\(10001\)/);
  assert.match(reply, /龙王乙\(10002\)｜连续 3 天/);
  assert.match(reply, /群聊之火（1）：/);
  assert.equal(calls.honorReads.length, 1);
  assert.equal(calls.honorReads[0].group_id, GROUP);
  assert.equal(calls.honorReads[0].type, 'all');
});

await test('@全体剩余：调用 get_group_at_all_remain 并格式化', async () => {
  calls.atAllReads.length = 0;
  calls.atAllRemains = {
    can_at_all: true,
    remain_at_all_count_for_group: 19,
    remain_at_all_count_for_uin: 10
  };
  const reply = await cmd(`[@全体剩余 ${GROUP}]`);
  assert.match(reply, new RegExp(`【@全体剩余】群 ${GROUP}`));
  assert.match(reply, /可@全体：是/);
  assert.match(reply, /群剩余次数：19/);
  assert.match(reply, /我的剩余次数：10/);
  assert.equal(calls.atAllReads.length, 1);
  assert.equal(calls.atAllReads[0].group_id, GROUP);
});

await test('群头衔：未确认只提示，确认后调用 set_group_special_title', async () => {
  calls.specialTitles.length = 0;
  let reply = await cmd(`[群头衔 ${GROUP} ${STRANGER} 摸鱼达人]`);
  assert.match(reply, /危险操作：设置群头衔/);
  assert.equal(calls.specialTitles.length, 0, '未确认不能调用接口');

  reply = await cmd(`[群头衔 ${GROUP} ${STRANGER} 摸鱼达人 确认]`);
  assert.match(reply, /头衔改为「摸鱼达人」/);
  assert.equal(calls.specialTitles.length, 1);
  // 参数来自 VM 上下文，原型与测试运行时不共享，逐字段断言。
  assert.equal(calls.specialTitles[0].group_id, GROUP);
  assert.equal(calls.specialTitles[0].user_id, STRANGER);
  assert.equal(calls.specialTitles[0].special_title, '摸鱼达人');
});

await test('设精华 / 取消精华：需要确认并调用对应 action', async () => {
  calls.essenceSet.length = 0;
  calls.essenceDeleted.length = 0;

  let reply = await cmd('[设精华 -123456789]');
  assert.match(reply, /危险操作：设置精华消息/);
  assert.equal(calls.essenceSet.length, 0);

  reply = await cmd('[设精华 -123456789 确认]');
  assert.match(reply, /已把消息 -123456789 设为精华/);
  assert.equal(calls.essenceSet.length, 1);
  assert.equal(calls.essenceSet[0].message_id, -123456789);

  reply = await cmd('[取消精华 -123456789]');
  assert.match(reply, /危险操作：取消精华消息/);
  assert.equal(calls.essenceDeleted.length, 0);

  reply = await cmd('[取消精华 -123456789 确认]');
  assert.match(reply, /已取消消息 -123456789 的精华/);
  assert.equal(calls.essenceDeleted.length, 1);
  assert.equal(calls.essenceDeleted[0].message_id, -123456789);
});

await test('群签到：调用 set_group_sign，不需要确认', async () => {
  calls.groupSigns.length = 0;
  const reply = await cmd(`[群签到 ${GROUP}]`);
  assert.match(reply, new RegExp(`已在群 ${GROUP} 完成签到`));
  assert.equal(calls.groupSigns.length, 1);
  assert.equal(calls.groupSigns[0].group_id, GROUP);
});

await test('标记已读：群目标调用 mark_group_msg_as_read', async () => {
  calls.marks.length = 0;
  calls.groupHistory = [{ message_id: -5, time: Math.floor(Date.now() / 1000) }];
  const reply = await cmd(`[标记已读 ${GROUP}]`);
  assert.match(reply, new RegExp(`已标记已读｜群 ${GROUP}｜最新消息 #-5`));
  assert.equal(calls.marks.length, 1);
  assert.equal(calls.marks[0].action, 'mark_group_msg_as_read');
  assert.equal(calls.marks[0].message_id, -5);
  assert.equal(calls.marks[0].group_id, GROUP);
});

await test('标记已读：非群目标按私聊调用 mark_private_msg_as_read', async () => {
  calls.marks.length = 0;
  calls.groupInfoFailIds = [STRANGER];
  calls.friendHistory = [{ message_id: 123, time: Math.floor(Date.now() / 1000) }];
  const reply = await cmd(`[标记已读 ${STRANGER}]`);
  assert.match(reply, new RegExp(`已标记已读｜私聊 ${STRANGER}｜最新消息 #123`));
  assert.equal(calls.marks.length, 1);
  assert.equal(calls.marks[0].action, 'mark_private_msg_as_read');
  assert.equal(calls.marks[0].message_id, 123);
  assert.equal(calls.marks[0].user_id, STRANGER);
});

await test('看转发：调用 get_forward_msg 并输出摘要', async () => {
  calls.forwardReads.length = 0;
  calls.forwardMessages = [
    { sender: { nickname: '张三', user_id: 10001 }, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '第一句' } }] },
    { sender: { card: '李四', user_id: 10002 }, time: Math.floor(Date.now() / 1000), message: '第二句' }
  ];
  const reply = await cmd('[看转发 fwd_abc-123]');
  assert.match(reply, /【转发内容】共 2 条/);
  assert.match(reply, /张三\(10001\)：第一句/);
  assert.match(reply, /李四\(10002\)：第二句/);
  assert.equal(calls.forwardReads.length, 1);
  assert.equal(calls.forwardReads[0].id, 'fwd_abc-123');
});

await test('原生表情：sendToQQ 把 [狗头] 转成 face 段', async () => {
  calls.sent.length = 0;
  await bridge.sendToQQ('private:123', '笑死 [狗头]');
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].text, '笑死 [face:277]');
  const face = Array.isArray(calls.sent[0].segments)
    ? calls.sent[0].segments.find((seg) => seg.type === 'face')
    : null;
  assert.ok(face, '应当有 face 段');
  assert.equal(face.data.id, '277');
});

await test('原生表情：未知方括号原样保留', async () => {
  calls.sent.length = 0;
  await bridge.sendToQQ('private:123', '[图片] 你好');
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].text, '[图片] 你好');
});

await test('/reset 需要二次确认', async () => {
  const reply = await cmd('/reset');
  assert.match(reply, /危险操作：\/reset/);
  assert.match(reply, /\/reset 确认/);
});

await test('白名单：查看私聊，列出好友未加入', async () => {
  calls.qzoneFriends = [{ user_id: 7770486, nickname: '示例好友甲' }];
  const reply = await cmd('[私聊白名单]');
  assert.match(reply, /【私聊白名单】/);
  assert.match(reply, /123/);
  assert.match(reply, /【好友未加入】1 个/);
  assert.match(reply, /示例好友甲\(7770486\)/);
});

await test('白名单：添加/删除私聊后热更新 config.json', async () => {
  let reply = await cmd('[私聊白名单 添加 7770486]');
  assert.match(reply, /已添加 1 个/);
  assert.ok(bridge.cfg.allow.private.includes(7770486));
  let saved = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.ok(saved.allow.private.map(Number).includes(7770486));

  reply = await cmd('[私聊白名单 删除 7770486]');
  assert.match(reply, /已移除 1 个/);
  assert.ok(!bridge.cfg.allow.private.includes(7770486));
  saved = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.ok(!saved.allow.private.map(Number).includes(7770486));
  // 每次写 config.json 前都应留一份自动回滚点。
  const backups = fs.readdirSync(temp).filter((n) => n.startsWith('config.json.bak-auto-'));
  assert.ok(backups.length >= 1, 'config.json 写前应自动备份');
});

await test('白名单：管理员 QQ 不能被移出', async () => {
  // 主 harness 的 owner 是 123（3 位），不是合法 QQ 号；单独起一个真实长度 owner 的 harness。
  const b2 = await bridgeHarness({
    config: {
      consolePort: 0,
      ownerQQ: 7770486,
      allow: { private: ['7770486'], groups: [] }
    }
  });
  try {
    b2.setMode('reserved2');
    b2.calls.sent.length = 0;
    await b2.handleIncoming('private', 7770486, {
      user_id: 7770486,
      self_id: 1,
      message_id: String(Date.now()),
      message: [{ type: 'text', data: { text: '[私聊白名单 删除 7770486]' } }],
      raw_message: '[私聊白名单 删除 7770486]'
    }, b2.cfg);
    const reply = b2.calls.sent.map((m) => m.text).join('\n');
    assert.match(reply, /管理员 QQ 7770486 不能移出/);
    assert.ok(b2.cfg.allow.private.map(Number).includes(7770486));
  } finally {
    await b2.close();
  }
});

await test('白名单：群聊添加并在列表里显示未加入群', async () => {
  calls.groups = [
    { group_id: 7000001, group_name: '测试群聊' },
    { group_id: 7000002, group_name: '另一个群' },
    { group_id: 3331193297, group_name: '第三个群' }
  ];
  let reply = await cmd('[群聊白名单 添加 7000002]');
  assert.match(reply, /已添加 1 个/);
  assert.ok(bridge.cfg.allow.groups.includes(7000002));

  reply = await cmd('[群聊白名单]');
  assert.match(reply, /【群聊白名单】2 个/);
  assert.match(reply, /测试群聊\(7000001\)/);
  assert.match(reply, /另一个群\(7000002\)/);
  assert.match(reply, /【已在群里但未加入】1 个/);
  assert.match(reply, /第三个群\(3331193297\)/);
});

await test('白名单：群聊清空需要确认并落盘', async () => {
  let reply = await cmd('[群聊白名单 清空]');
  assert.match(reply, /危险操作：整体替换/);
  assert.ok(bridge.cfg.allow.groups.includes(7000002), '未确认时不能清空');

  reply = await cmd('[群聊白名单 清空 确认]');
  assert.match(reply, /已设置 0 个/);
  assert.equal(bridge.cfg.allow.groups.length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.equal(saved.allow.groups.length, 0);
});

await test('白名单：新好友事件默认加入私聊白名单', async () => {
  calls.sent.length = 0;
  await bridge.handleFriendAddedEvent({ user_id: 55555555, time: Math.floor(Date.now() / 1000) });
  assert.ok(bridge.cfg.allow.private.includes(55555555), '新好友应自动进入白名单');
  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.ok(saved.allow.private.map(Number).includes(55555555));
  const notice = calls.sent.map((m) => m.text).join('\n');
  assert.match(notice, /已默认加入私聊白名单/);
});

await test('扩展：高级帮助 / 备份状态', async () => {
  let reply = await cmd('[高级帮助]');
  assert.match(reply, /【高级帮助】/);
  assert.match(reply, /备份状态/);
  reply = await cmd('[备份状态]');
  assert.match(reply, /【备份状态】/);
  assert.match(reply, /服务器：缺失/);
});

await test('扩展：群成员查 / 拍一拍', async () => {
  calls.groupMembers = [
    { user_id: 7770486, nickname: '示例好友甲', card: '', role: 'member', join_time: Math.floor(Date.now() / 1000), last_sent_time: Math.floor(Date.now() / 1000) },
    { user_id: 7040348, nickname: '示例昵称', card: '示例好友乙', role: 'admin', join_time: Math.floor(Date.now() / 1000), last_sent_time: Math.floor(Date.now() / 1000) }
  ];
  let reply = await cmd('[群成员查 7000001 示例好友甲]');
  assert.match(reply, /【群成员查】群 7000001/);
  assert.match(reply, /示例好友甲\(7770486\)/);
  assert.doesNotMatch(reply, /示例好友乙\(7040348\)/);

  reply = await cmd('[拍一拍 7770486]');
  assert.match(reply, /已拍一拍 QQ 7770486/);
  assert.equal(calls.pokes.at(-1).user_id, 7770486);
  assert.equal(calls.pokes.at(-1).group_id, undefined);

  reply = await cmd('[拍一拍 7000001 7770486]');
  assert.match(reply, /已拍一拍群 7000001 里的 QQ 7770486/);
  assert.equal(calls.pokes.at(-1).group_id, 7000001);
  assert.equal(calls.pokes.at(-1).user_id, 7770486);
});

await test('扩展：清上下文 / 撤回最近', async () => {
  calls.groupInfoFailIds = [7770486];
  let reply = await cmd('[清上下文 7770486]');
  assert.match(reply, /危险操作：清空目标会话的上下文/);
  reply = await cmd('[清上下文 7770486 确认]');
  assert.match(reply, /还没有上下文/);

  calls.friendHistory = [{
    message_id: -123,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 2867977191, nickname: '樱良' },
    message: [{ type: 'text', data: { text: '测试消息' } }]
  }];
  reply = await cmd('[撤回最近]');
  assert.match(reply, /危险操作：撤回机器人最近一条消息/);
  reply = await cmd('[撤回最近 确认]');
  assert.match(reply, /已撤回最近一条消息 #-123/);
  assert.equal(calls.deletedMsgs.at(-1).message_id, -123);
});

await test('扩展：我的名片赞 / 记忆列表 / 收藏列表', async () => {
  calls.profileLike = {
    favoriteInfo: {
      total_count: 2,
      today_count: 2,
      userInfos: [{ uin: 7770486, count: 2, latestTime: Math.floor(Date.now() / 1000) }]
    },
    voteInfo: { total_count: 0, new_count: 0, userInfos: [] }
  };
  let reply = await cmd('[我的名片赞]');
  assert.match(reply, /【我的名片赞】今日 2 次/);
  assert.match(reply, /7770486/);

  bridge.socialV2.conversations.set('private:55555555', {
    memberImpressions: { '测试好友': { traits: ['喜欢猫'], interactionCount: 2, lastSeenAt: Date.now() } },
    activeTopics: [{ text: '周末去爬山', lastMentionAt: Date.now() }],
    pendingThoughts: [],
    lastIncomingAt: Date.now()
  });
  reply = await cmd('[记忆列表]');
  assert.match(reply, /【记忆列表】/);
  assert.match(reply, /喜欢猫/);
  assert.match(reply, /周末去爬山/);
  bridge.socialV2.conversations.delete('private:55555555');

  reply = await cmd('[收藏列表]');
  assert.match(reply, /【收藏表情】/);
});

await test('扩展：忘记记忆先预览、确认后删除并备份', async () => {
  const memKey = 'private:55555555';
  bridge.socialV2.conversations.set(memKey, {
    memberImpressions: { '测试好友': { traits: ['喜欢猫'], interactionCount: 1, lastSeenAt: Date.now() } },
    activeTopics: [{ text: '周末去爬山', lastMentionAt: Date.now() }],
    pendingThoughts: [],
    lastIncomingAt: Date.now()
  });
  const socialFile = path.join(temp, 'state', 'social-v2.json');
  if (!fs.existsSync(socialFile)) fs.writeFileSync(socialFile, '{}', 'utf8');

  let reply = await cmd('[忘记记忆 喜欢猫]');
  assert.match(reply, /匹配 1 条/);
  assert.match(reply, /确认请发/);
  assert.ok(bridge.socialV2.conversations.get(memKey).memberImpressions['测试好友'], '未确认不能删');

  reply = await cmd('[忘记记忆 喜欢猫 确认]');
  assert.match(reply, /已删除 1 条记忆/);
  assert.equal(bridge.socialV2.conversations.get(memKey).memberImpressions['测试好友'], undefined);
  assert.ok(fs.readdirSync(path.join(temp, 'state')).some((n) => n.includes('.bak-memory-')), '删除前应有备份');
  bridge.socialV2.conversations.delete(memKey);
});

await test('扩展：改昵称需要确认', async () => {
  let reply = await cmd('[改昵称 测试昵称]');
  assert.match(reply, /危险操作：把机器人昵称改为「测试昵称」/);
  reply = await cmd('[改昵称 测试昵称 确认]');
  assert.match(reply, /已把昵称改为「测试昵称」/);
  assert.equal(calls.profileChanges.at(-1).nickname, '测试昵称');
});

await test('只读指令不写 unread / recentMessages', async () => {
  const st = bridge.getSocialV2State('private:123');
  assert.equal(st.unread.length, 0);
  assert.equal(st.recentMessages.length, 0);
});

await bridge.close();
console.log(`\nowner-inspect bridge tests: ${passed} passed`);
