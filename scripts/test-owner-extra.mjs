// owner-extra 纯函数自检：
// 1. 全部扩展指令 / 别名 / 缺参 / 确认 / 普通聊天不误判
// 2. 备份正常 / 缺失 / 超时
// 3. 群成员查：QQ / 名片 / 昵称（大小写）/ 头衔 / 角色 / 截断 / 无匹配
// 4. 名片赞排序与空数据
// 5. 记忆列表 / 截断 / 空；记忆匹配 / 截断 / 空
// 6. 拍一拍 / 清上下文 / 撤回 / 改昵称 的成功与失败
// 7. 收藏摘要
// 运行：node scripts/test-owner-extra.mjs
// 所有时间都围绕固定 NOW 构造，不依赖本机时区。
import assert from 'node:assert/strict';
import {
  EXTRA_HELP,
  parseOwnerExtraCommand,
  formatBackupStatus,
  formatMemberSearch,
  formatProfileLikes,
  formatMemoryList,
  formatMemoryMatches,
  formatPokeResult,
  formatClearContextResult,
  formatRecallResult,
  formatNicknameResult,
  formatStickerSummary
} from '../src/owner-extra.js';

const NOW = Date.parse('2026-10-20T16:00:00+08:00');
const at = (iso) => Date.parse(iso);
const HOUR = 3600000;
const DAY = 24 * HOUR;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

// ── 1. 帮助与解析 ─────────────────────────────────────────────────────────

test('EXTRA_HELP 覆盖全部指令与写法说明', () => {
  assert.equal(typeof EXTRA_HELP, 'string');
  for (const keyword of [
    '备份状态', '群成员查', '拍一拍', '清上下文', '撤回最近', '我的名片赞',
    '记忆列表', '忘记记忆', '收藏列表', '改昵称',
    '消息表情回应', '主动唤醒', '主动对话', '限额调整', '限额重置', '定时任务', '查询模型余额',
    '高级帮助'
  ]) {
    assert.ok(EXTRA_HELP.includes(keyword), keyword);
  }
  assert.ok(EXTRA_HELP.includes('方括号可省略'));
  assert.ok(EXTRA_HELP.includes('确认'));
  assert.ok(EXTRA_HELP.includes('5~12'));
});

test('备份状态：全部别名', () => {
  for (const text of ['备份状态', '[备份状态]', '【备份】', '备份检查', '备份状态：']) {
    assert.deepEqual(parseOwnerExtraCommand(text), { ok: true, action: 'backupStatus' }, text);
  }
});

test('群成员查：群号 + 关键词（含空格），缺群号/缺关键词', () => {
  assert.deepEqual(parseOwnerExtraCommand('[群成员查 7000001 张 三]'), {
    ok: true, action: 'memberSearch', groupId: 7000001, query: '张 三'
  });
  assert.deepEqual(parseOwnerExtraCommand('查群成员'), { ok: true, action: 'memberSearch', groupId: 0, query: '' });
  assert.deepEqual(parseOwnerExtraCommand('群成员搜索 张三'), { ok: true, action: 'memberSearch', groupId: 0, query: '张三' });
  assert.deepEqual(parseOwnerExtraCommand('群成员查 12345'), { ok: true, action: 'memberSearch', groupId: 12345, query: '' });
  assert.deepEqual(parseOwnerExtraCommand('群成员查：7000001：阿明'), {
    ok: true, action: 'memberSearch', groupId: 7000001, query: '阿明'
  });
  // 4 位数字不是群号，当关键词
  assert.deepEqual(parseOwnerExtraCommand('群成员查 1234'), { ok: true, action: 'memberSearch', groupId: 0, query: '1234' });
});

test('分段写法：群名/好友名可带空格', () => {
  assert.deepEqual(parseOwnerExtraCommand('[群成员查][测试 群聊][雨]'), {
    ok: true, action: 'memberSearch', groupId: 0, groupText: '测试 群聊', query: '雨'
  });
  assert.deepEqual(parseOwnerExtraCommand('[拍一拍][测试群聊][示例好友甲]'), {
    ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0,
    groupText: '测试群聊', userText: '示例好友甲'
  });
  assert.deepEqual(parseOwnerExtraCommand('[拍一拍][示例好友甲]'), {
    ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0, userText: '示例好友甲'
  });
  assert.deepEqual(parseOwnerExtraCommand('[清上下文][测试 群聊][确认]'), {
    ok: true, action: 'clearContext', targetId: 0, targetText: '测试 群聊', confirmed: true
  });

  // 传统空格写法也支持名字。
  assert.deepEqual(parseOwnerExtraCommand('群成员查 测试群 雨'), {
    ok: true, action: 'memberSearch', groupId: 0, groupText: '测试群', query: '雨'
  });
  assert.deepEqual(parseOwnerExtraCommand('拍一拍 测试群 示例好友甲'), {
    ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0,
    groupText: '测试群', userText: '示例好友甲'
  });
  assert.deepEqual(parseOwnerExtraCommand('清上下文 测试群 确认'), {
    ok: true, action: 'clearContext', targetId: 0, targetText: '测试群', confirmed: true
  });
});

test('拍一拍：私聊 / 群聊 / 缺参', () => {
  assert.deepEqual(parseOwnerExtraCommand('拍一拍 10001'), {
    ok: true, action: 'poke', groupId: 0, targetId: 10001, userId: 10001
  });
  assert.deepEqual(parseOwnerExtraCommand('【戳一戳 7000001 10001】'), {
    ok: true, action: 'poke', groupId: 7000001, targetId: 10001, userId: 10001
  });
  assert.deepEqual(parseOwnerExtraCommand('拍一拍'), {
    ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0
  });
  assert.deepEqual(parseOwnerExtraCommand('拍一拍 1234'), {
    ok: true, action: 'poke', groupId: 0, targetId: 0, userId: 0
  });
});

test('清上下文：目标号与确认', () => {
  assert.deepEqual(parseOwnerExtraCommand('清上下文 10001'), {
    ok: true, action: 'clearContext', targetId: 10001, confirmed: false
  });
  assert.deepEqual(parseOwnerExtraCommand('清除上下文：7000001 确认'), {
    ok: true, action: 'clearContext', targetId: 7000001, confirmed: true
  });
  assert.deepEqual(parseOwnerExtraCommand('清理上下文 群 10001 确认！'), {
    ok: true, action: 'clearContext', targetId: 10001, confirmed: true
  });
  assert.deepEqual(parseOwnerExtraCommand('清上下文'), {
    ok: true, action: 'clearContext', targetId: 0, confirmed: false
  });
});

test('撤回最近：三个别名与确认', () => {
  assert.deepEqual(parseOwnerExtraCommand('撤回最近'), { ok: true, action: 'recallLast' });
  assert.deepEqual(parseOwnerExtraCommand('撤回上一条'), { ok: true, action: 'recallLast' });
  assert.deepEqual(parseOwnerExtraCommand('撤回最后一条 确认'), { ok: true, action: 'recallLast', confirmed: true });
  assert.deepEqual(parseOwnerExtraCommand('[撤回最近 确认]'), { ok: true, action: 'recallLast', confirmed: true });
});

test('我的名片赞 / 记忆列表 / 高级帮助：全部别名', () => {
  for (const text of ['我的名片赞', '名片赞', '【获赞】']) {
    assert.deepEqual(parseOwnerExtraCommand(text), { ok: true, action: 'profileLikes' }, text);
  }
  for (const text of ['记忆列表', '[查看记忆]', '记忆概览']) {
    assert.deepEqual(parseOwnerExtraCommand(text), { ok: true, action: 'memoryList' }, text);
  }
  for (const text of ['高级帮助', '更多帮助', '【扩展帮助】']) {
    assert.deepEqual(parseOwnerExtraCommand(text), { ok: true, action: 'help' }, text);
  }
});

test('忘记记忆：关键词可含空格，末尾确认', () => {
  assert.deepEqual(parseOwnerExtraCommand('忘记记忆 猫'), { ok: true, action: 'forgetMemory', keyword: '猫' });
  assert.deepEqual(parseOwnerExtraCommand('删除记忆 今天 天气 确认'), {
    ok: true, action: 'forgetMemory', keyword: '今天 天气', confirmed: true
  });
  assert.deepEqual(parseOwnerExtraCommand('忘记记忆'), { ok: true, action: 'forgetMemory', keyword: '' });
  assert.deepEqual(parseOwnerExtraCommand('忘记记忆 确认'), {
    ok: true, action: 'forgetMemory', keyword: '', confirmed: true
  });
});

test('收藏列表：关键词可选', () => {
  assert.deepEqual(parseOwnerExtraCommand('收藏列表'), { ok: true, action: 'stickerList', keyword: '' });
  assert.deepEqual(parseOwnerExtraCommand('表情库 猫'), { ok: true, action: 'stickerList', keyword: '猫' });
  assert.deepEqual(parseOwnerExtraCommand('[收藏表情 猫 图]'), { ok: true, action: 'stickerList', keyword: '猫 图' });
});

test('改昵称：昵称可含空格，末尾确认', () => {
  assert.deepEqual(parseOwnerExtraCommand('改昵称 小 助手 确认'), {
    ok: true, action: 'setNickname', nickname: '小 助手', confirmed: true
  });
  assert.deepEqual(parseOwnerExtraCommand('修改昵称 小助手'), { ok: true, action: 'setNickname', nickname: '小助手' });
  assert.deepEqual(parseOwnerExtraCommand('改昵称'), { ok: true, action: 'setNickname', nickname: '' });
});

test('普通聊天不误判', () => {
  for (const text of ['你好', '今天天气不错', '在吗？', '123456', '', '   ', '随便聊聊吧']) {
    assert.deepEqual(parseOwnerExtraCommand(text), { ok: false }, JSON.stringify(text));
  }
});

// ── 2. 备份状态 ───────────────────────────────────────────────────────────

test('备份状态：正常', () => {
  const text = formatBackupStatus({
    server: { path: '/srv/bak', at: NOW - 30 * 60000, size: 12.3 * 1024 * 1024, sha256: 'deadbeef' },
    offsite: { at: NOW - 2 * HOUR },
    now: NOW
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '【备份状态】');
  assert.equal(lines[1], '服务器：2026-10-20 15:30 · 30分前 · 12.3 MB · sha256 ✓');
  assert.equal(lines[2], '异地：2026-10-20 14:00 · 2小时0分前 · 心跳正常');
  assert.equal(lines[3], '结论：正常');
});

test('备份状态：全部缺失（含 null 入参）', () => {
  const text = formatBackupStatus();
  assert.ok(text.includes('服务器：缺失 ⚠️'));
  assert.ok(text.includes('异地：缺失 · 心跳缺失 ⚠️'));
  assert.ok(text.includes('结论：备份缺失，请检查'));

  const nulled = formatBackupStatus({ server: null, offsite: null, now: NOW });
  assert.ok(nulled.includes('结论：备份缺失，请检查'));
});

test('备份状态：超过阈值标 ⚠️', () => {
  const text = formatBackupStatus({
    server: { at: NOW - 40 * HOUR, size: 1024 * 1024, sha256: '' },
    offsite: { at: NOW - 3 * DAY },
    now: NOW
  });
  const lines = text.split('\n');
  assert.ok(lines[1].includes('2026-10-19 00:00'), lines[1]);
  assert.ok(lines[1].includes('1天前'), lines[1]);
  assert.ok(lines[1].includes('1.0 MB'), lines[1]);
  assert.ok(lines[1].includes('sha256 缺失'), lines[1]);
  assert.ok(lines[1].endsWith('⚠️'), lines[1]);
  assert.ok(lines[2].includes('3天前') && lines[2].endsWith('⚠️'), lines[2]);
  assert.equal(lines[3], '结论：超过 36 小时，请检查');

  const custom = formatBackupStatus({ server: { at: NOW - 2 * HOUR }, offsite: { at: NOW - 2 * HOUR }, now: NOW, thresholdHours: 1 });
  assert.ok(custom.includes('结论：超过 1 小时，请检查'));
});

// ── 3. 群成员查 ───────────────────────────────────────────────────────────

const GROUP_ID = 7000001;
const MEMBERS = [
  {
    user_id: 10001, nickname: '小明', card: '阿明', role: 'owner', title: '群主本主',
    join_time: at('2024-03-05T10:00:00+08:00') / 1000, last_sent_time: NOW / 1000 - 3600
  },
  {
    user_id: 10002, nickname: 'Alice', card: '', role: 'admin', title: '',
    join_time: at('2025-01-02T03:04:00+08:00') / 1000, last_sent_time: NOW / 1000 - 86400
  },
  {
    user_id: 20003, nickname: '老王', card: '路人王', role: 'member', title: '摸鱼中',
    join_time: 0, last_sent_time: 0
  }
];

test('群成员查：按 QQ 号匹配，秒级时间戳转北京时间', () => {
  const text = formatMemberSearch({ groupId: GROUP_ID, members: MEMBERS, query: '10002', now: NOW });
  const lines = text.split('\n');
  assert.equal(lines[0], `【群成员查】群 ${GROUP_ID}｜关键词「10002」｜1 人`);
  assert.equal(lines[1], '1. Alice(10002)｜管理员｜入群 2025-01-02｜最后发言 10-19 16:00');
});

test('群成员查：名片优先、角色与头衔', () => {
  const text = formatMemberSearch({ groupId: GROUP_ID, members: MEMBERS, query: '阿明', now: NOW });
  assert.ok(text.includes('1. 阿明(10001)｜群主｜群主本主｜入群 2024-03-05｜最后发言 10-20 15:00'), text);

  const byTitle = formatMemberSearch({ groupId: GROUP_ID, members: MEMBERS, query: '摸鱼', now: NOW });
  assert.ok(byTitle.includes('路人王(20003)｜成员｜摸鱼中｜入群 未知｜最后发言 未知'), byTitle);
});

test('群成员查：昵称匹配不区分大小写', () => {
  const text = formatMemberSearch({ groupId: GROUP_ID, members: MEMBERS, query: 'alice', now: NOW });
  assert.ok(text.includes('1. Alice(10002)'), text);
});

test('群成员查：截断与无匹配', () => {
  const text = formatMemberSearch({ groupId: GROUP_ID, members: MEMBERS, query: '', now: NOW, limit: 2 });
  const lines = text.split('\n');
  assert.equal(lines[0], `【群成员查】群 ${GROUP_ID}｜关键词「（全部）」｜3 人`);
  assert.equal(lines[3], '只显示前 2 人。');

  const none = formatMemberSearch({ groupId: GROUP_ID, members: MEMBERS, query: 'zzz', now: NOW });
  assert.ok(none.includes('没找到匹配的成员。'), none);

  const empty = formatMemberSearch();
  assert.ok(empty.includes('【群成员查】群 未知｜关键词「（全部）」｜0 人'), empty);
  assert.ok(empty.includes('没找到匹配的成员。'));
});

// ── 4. 我的名片赞 ─────────────────────────────────────────────────────────

const LIKE_DATA = {
  favoriteInfo: {
    total_count: 128,
    today_count: 6,
    userInfos: [
      { uin: 10001, count: 3, latestTime: NOW - 10 * 60000 },
      { uin: 10002, count: 9, latestTime: NOW - DAY }
    ]
  }
};

test('名片赞：按次数降序，labels 覆盖昵称', () => {
  const text = formatProfileLikes({ data: LIKE_DATA, labels: { 10001: '阿明' }, now: NOW });
  const lines = text.split('\n');
  assert.equal(lines[0], '【我的名片赞】今日 6 次｜可见累计 128 次｜点赞用户 2 位');
  assert.equal(lines[1], '1. QQ 10002｜9 次｜最近 10-19 16:00');
  assert.equal(lines[2], '2. 阿明(10001)｜3 次｜最近 10-20 15:50');
});

test('名片赞：空名单 / 未返回数据 / 截断', () => {
  const empty = formatProfileLikes({ now: NOW });
  assert.equal(empty.split('\n')[0], '【我的名片赞】今日 0 次｜可见累计 0 次｜点赞用户 0 位');
  assert.ok(empty.includes('暂时看不到点赞用户'));

  const nulled = formatProfileLikes({ data: null, labels: null });
  assert.ok(nulled.includes('点赞用户 0 位'));

  const capped = formatProfileLikes({ data: LIKE_DATA, limit: 1, now: NOW });
  assert.ok(capped.includes('只显示前 1 位。'), capped);

  const vote = formatProfileLikes({
    data: { ...LIKE_DATA, voteInfo: { today_count: 2, total_count: 5 } },
    now: NOW
  });
  assert.ok(vote.includes('投票：今日 2 次｜累计 5 次'), vote);
});

// ── 5. 记忆列表 / 记忆匹配 ────────────────────────────────────────────────

const CONVERSATIONS = [
  {
    key: 'private:10001',
    impressions: { 游戏搭子: { traits: ['幽默', '话多'], interactionCount: 12, lastSeenAt: NOW } },
    topics: [{ text: '周末开黑' }],
    thoughts: [{ text: '喜欢被叫老哥' }]
  },
  { key: 'group:7000001', impressions: {}, topics: [], thoughts: [] }
];

test('记忆列表：会话数、向量数与每会话三种记忆', () => {
  const text = formatMemoryList({ conversations: CONVERSATIONS, vectorCount: 34, now: NOW });
  const lines = text.split('\n');
  assert.equal(lines[0], '【记忆列表】2 个会话｜向量 34 条');
  assert.equal(lines[1], '1. private:10001');
  assert.equal(lines[2], '   印象：游戏搭子（12 次）：幽默、话多');
  assert.equal(lines[3], '   话题：周末开黑');
  assert.equal(lines[4], '   想法：喜欢被叫老哥');
  assert.equal(lines[5], '2. group:7000001');
});

test('记忆列表：截断 60 字、会话上限、空记忆', () => {
  const long = formatMemoryList({
    conversations: [{ key: 'k', thoughts: [{ text: 'x'.repeat(80) }] }],
    now: NOW
  });
  assert.ok(long.includes(`   想法：${'x'.repeat(60)}…`), long);

  const capped = formatMemoryList({ conversations: CONVERSATIONS, limit: 1, now: NOW });
  assert.ok(capped.includes('只显示前 1 个会话。'), capped);

  const empty = formatMemoryList();
  assert.equal(empty.split('\n')[0], '【记忆列表】0 个会话｜向量 0 条');
  assert.ok(empty.includes('暂无记忆。'));

  const junk = formatMemoryList({ conversations: [null, { key: '' }] });
  assert.ok(junk.includes('1. 未知会话'), junk);
});

test('记忆匹配：结果行、截断 80 字、无匹配', () => {
  const text = formatMemoryMatches({
    keyword: '猫',
    matches: [
      { key: 'private:10001', kind: '印象', text: '喜欢猫' },
      { key: 'group:7000001', kind: '话题', text: '猫粮推荐' }
    ]
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '【忘记记忆】关键词「猫」｜匹配 2 条');
  assert.equal(lines[1], '1. private:10001｜印象｜喜欢猫');
  assert.equal(lines[2], '2. group:7000001｜话题｜猫粮推荐');

  const long = formatMemoryMatches({ keyword: 'x', matches: [{ key: 'k', kind: '想法', text: 'y'.repeat(100) }] });
  assert.ok(long.includes(`｜${'y'.repeat(80)}…`), long);

  const capped = formatMemoryMatches({
    keyword: '猫',
    matches: [{ key: 'a', kind: '印象', text: '1' }, { key: 'b', kind: '话题', text: '2' }],
    limit: 1
  });
  assert.ok(capped.includes('只显示前 1 条。'), capped);

  const none = formatMemoryMatches({ keyword: '猫' });
  assert.equal(none.split('\n')[0], '【忘记记忆】关键词「猫」｜匹配 0 条');
  assert.ok(none.includes('没有匹配到记忆。'));
});

// ── 6. 动作结果 ───────────────────────────────────────────────────────────

test('拍一拍结果：私聊 / 群聊 / 失败', () => {
  assert.equal(formatPokeResult({ targetId: 10001 }), '已拍一拍 QQ 10001');
  assert.equal(formatPokeResult({ groupId: GROUP_ID, targetId: 10001 }), `已拍一拍群 ${GROUP_ID} 里的 QQ 10001`);
  assert.equal(formatPokeResult({ targetId: 10001, ok: false, error: '机器人不在群里' }), '拍一拍失败：机器人不在群里');
  assert.equal(formatPokeResult({ ok: false }), '拍一拍失败：未知错误');
});

test('清上下文结果：私聊 / 群 / 失败', () => {
  assert.equal(formatClearContextResult({ targetId: 10001 }), '已清空 私聊 10001 的上下文（记忆保留）');
  assert.equal(
    formatClearContextResult({ kind: 'group', targetId: GROUP_ID }),
    `已清空 群 ${GROUP_ID} 的上下文（记忆保留）`
  );
  assert.equal(formatClearContextResult({ ok: false, error: '目标不存在' }), '清上下文失败：目标不存在');
  assert.equal(formatClearContextResult({ ok: false }), '清上下文失败：未知错误');
});

test('撤回结果：带 id / 不带 id / 失败', () => {
  assert.equal(formatRecallResult({ messageId: 456, preview: '晚安' }), '已撤回最近一条消息 #456：晚安');
  assert.equal(formatRecallResult({ messageId: 456 }), '已撤回最近一条消息 #456');
  assert.equal(formatRecallResult({ preview: '晚安' }), '已撤回最近一条消息：晚安');
  assert.equal(formatRecallResult({ ok: false, error: '没有可撤回的消息' }), '撤回最近失败：没有可撤回的消息');
});

test('改昵称结果：成功 / 失败', () => {
  assert.equal(formatNicknameResult({ nickname: '小助手' }), '已把昵称改为「小助手」');
  assert.equal(formatNicknameResult({ ok: false, error: '昵称过长' }), '改昵称失败：昵称过长');
  assert.equal(formatNicknameResult({ ok: false }), '改昵称失败：未知错误');
});

// ── 7. 收藏摘要 ───────────────────────────────────────────────────────────

test('收藏摘要：条数、标签、使用次数、简化字段', () => {
  const result = {
    total: 3,
    matched: 2,
    truncated: false,
    stickers: [
      { id: 's1', desc: '猫猫头', localNote: '', tags: ['搞笑', '日常'], usage: '', useCount: 3 },
      { id: '', desc: '', localNote: '自制', tags: [], useCount: 0 }
    ]
  };
  const text = formatStickerSummary(result);
  const lines = text.split('\n');
  assert.equal(lines[0], '【收藏表情】共 3 个｜匹配 2 个');
  assert.equal(lines[1], '1. 猫猫头 [搞笑/日常] （用过3次） #s1');
  assert.equal(lines[2], '2. 自制');

  const withQuery = formatStickerSummary(result, { query: ' 猫 ' });
  assert.equal(withQuery.split('\n')[0], '【收藏表情】共 3 个｜匹配 2 个｜关键词「猫」');
});

test('收藏摘要：空库 / 无匹配 / 超过 20 条', () => {
  const empty = formatStickerSummary();
  assert.equal(empty.split('\n')[0], '【收藏表情】共 0 个｜匹配 0 个');
  assert.ok(empty.includes('收藏里还没有表情。'));

  const noMatch = formatStickerSummary({ total: 5, matched: 0, stickers: [] }, { query: '猫' });
  assert.ok(noMatch.includes('没有匹配到表情。'), noMatch);

  const many = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, desc: `表情${i}`, tags: [], useCount: 0 }));
  const capped = formatStickerSummary({ total: 25, matched: 25, stickers: many });
  assert.equal(capped.split('\n').filter((line) => line.startsWith('1.') || /^\d+\. /.test(line)).length, 20);
  assert.ok(capped.includes('只显示前 20 条。'), capped);
});

console.log(`owner-extra tests: ${passed} passed`);
