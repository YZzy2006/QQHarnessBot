// owner-inspect 纯函数自检：
// 1. 六组指令及别名解析（缺参返回 0 / 空串）
// 2. 今日用量：只算当天 turn，base/evict/昨天都不计入
// 3. 服务器统计：正常值与空对象（全部「未知」）
// 4. 群信息 / 群公告（数组与 {notices} 两种形状）
// 5. 标记已读成功/失败
// 6. 转发摘要正常/空
// 运行：node scripts/test-owner-inspect.mjs
// 所有时间都围绕固定 NOW 构造，不依赖本机时区。
import assert from 'node:assert/strict';
import {
  INSPECT_HELP,
  parseOwnerInspectCommand,
  formatTodayUsage,
  formatServerStats,
  formatGroupInfo,
  formatGroupNotice,
  formatGroupHonor,
  formatAtAllRemain,
  formatMarkReadResult,
  formatForwardSummary
} from '../src/owner-inspect.js';

const NOW = Date.parse('2026-10-20T14:05:00+08:00');
const at = (iso) => Date.parse(iso);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

// ── 1. 帮助与解析 ─────────────────────────────────────────────────────────

test('INSPECT_HELP 覆盖全部只读指令', () => {
  assert.equal(typeof INSPECT_HELP, 'string');
  for (const keyword of ['今日用量', '服务器', '群信息', '群公告', '群荣誉', '@全体剩余', '标记已读', '查看转发']) {
    assert.match(INSPECT_HELP, new RegExp(keyword));
  }
});

test('今日用量：全部别名', () => {
  for (const text of ['[今日用量]', '【今日成本】', '今日花费', '今日消耗', '今日消费', '今天用量', '今天的用量', '成本', '用量', '花费']) {
    assert.deepEqual(parseOwnerInspectCommand(text), { ok: true, action: 'usage' }, text);
  }
});

test('服务器：全部别名', () => {
  for (const text of ['服务器', '【服务器状态】', '系统状态', '机器状态', '主机状态', '资源', '资源占用']) {
    assert.deepEqual(parseOwnerInspectCommand(text), { ok: true, action: 'server' }, text);
  }
});

test('群信息：缺省群号 0，带群号/冒号/括号均可', () => {
  assert.deepEqual(parseOwnerInspectCommand('[群信息]'), { ok: true, action: 'groupInfo', groupId: 0 });
  assert.deepEqual(parseOwnerInspectCommand('群资料：7000001'), { ok: true, action: 'groupInfo', groupId: 7000001 });
  assert.deepEqual(parseOwnerInspectCommand('查看群信息 123456'), { ok: true, action: 'groupInfo', groupId: 123456 });
  assert.deepEqual(parseOwnerInspectCommand('查群'), { ok: true, action: 'groupInfo', groupId: 0 });
  assert.deepEqual(parseOwnerInspectCommand('群详情 99999'), { ok: true, action: 'groupInfo', groupId: 99999 });
});

test('群名：分段写法保留空格', () => {
  assert.deepEqual(parseOwnerInspectCommand('[群信息][测试 群聊]'), { ok: true, action: 'groupInfo', groupId: 0, groupText: '测试 群聊' });
  assert.deepEqual(parseOwnerInspectCommand('[群公告][测试群聊]'), { ok: true, action: 'groupNotice', groupId: 0, groupText: '测试群聊' });
  assert.deepEqual(parseOwnerInspectCommand('[群荣誉][测试群聊]'), { ok: true, action: 'groupHonor', groupId: 0, groupText: '测试群聊' });
  assert.deepEqual(parseOwnerInspectCommand('[@全体剩余][测试群聊]'), { ok: true, action: 'atAllRemain', groupId: 0, groupText: '测试群聊' });
  assert.deepEqual(parseOwnerInspectCommand('[标记已读][示例好友甲]'), { ok: true, action: 'markRead', targetId: 0, targetText: '示例好友甲' });
});

test('群名：单段空格/冒号写法', () => {
  assert.deepEqual(parseOwnerInspectCommand('[群信息 测试 群聊]'), { ok: true, action: 'groupInfo', groupId: 0, groupText: '测试 群聊' });
  assert.deepEqual(parseOwnerInspectCommand('群公告：测试群聊'), { ok: true, action: 'groupNotice', groupId: 0, groupText: '测试群聊' });
  assert.deepEqual(parseOwnerInspectCommand('群荣誉 测试群聊'), { ok: true, action: 'groupHonor', groupId: 0, groupText: '测试群聊' });
  assert.deepEqual(parseOwnerInspectCommand('@全体剩余 测试群聊'), { ok: true, action: 'atAllRemain', groupId: 0, groupText: '测试群聊' });
  assert.deepEqual(parseOwnerInspectCommand('标记已读 示例好友甲'), { ok: true, action: 'markRead', targetId: 0, targetText: '示例好友甲' });
  // 没有分隔符的普通语句不能被当成群名。
  assert.equal(parseOwnerInspectCommand('群信息很重要').ok, false);
});

test('群公告：缺省群号 0', () => {
  assert.deepEqual(parseOwnerInspectCommand('群公告'), { ok: true, action: 'groupNotice', groupId: 0 });
  assert.deepEqual(parseOwnerInspectCommand('查看群公告 7000001'), { ok: true, action: 'groupNotice', groupId: 7000001 });
  assert.deepEqual(parseOwnerInspectCommand('[群通知]'), { ok: true, action: 'groupNotice', groupId: 0 });
});

test('群荣誉：缺省群号 0，带群号/冒号/括号均可', () => {
  assert.deepEqual(parseOwnerInspectCommand('[群荣誉]'), { ok: true, action: 'groupHonor', groupId: 0 });
  assert.deepEqual(parseOwnerInspectCommand('群荣誉：7000001'), { ok: true, action: 'groupHonor', groupId: 7000001 });
  assert.deepEqual(parseOwnerInspectCommand('查看群荣誉 7000001'), { ok: true, action: 'groupHonor', groupId: 7000001 });
  assert.deepEqual(parseOwnerInspectCommand('群荣誉信息 123456'), { ok: true, action: 'groupHonor', groupId: 123456 });
});

test('@全体剩余：@ 可有可无，缺省群号 0', () => {
  assert.deepEqual(parseOwnerInspectCommand('[@全体剩余]'), { ok: true, action: 'atAllRemain', groupId: 0 });
  assert.deepEqual(parseOwnerInspectCommand('@全体剩余 7000001'), { ok: true, action: 'atAllRemain', groupId: 7000001 });
  assert.deepEqual(parseOwnerInspectCommand('[全体剩余 7000001]'), { ok: true, action: 'atAllRemain', groupId: 7000001 });
  // 普通 @全体成员 不能被当成指令。
  assert.equal(parseOwnerInspectCommand('@全体成员 注意今晚维护').ok, false);
});

test('标记已读：缺省 targetId 0，群/私聊都能解析出号码', () => {
  assert.deepEqual(parseOwnerInspectCommand('标记已读'), { ok: true, action: 'markRead', targetId: 0 });
  assert.deepEqual(parseOwnerInspectCommand('已读 10001'), { ok: true, action: 'markRead', targetId: 10001 });
  assert.deepEqual(parseOwnerInspectCommand('标记群已读 123456'), { ok: true, action: 'markRead', targetId: 123456 });
  assert.deepEqual(parseOwnerInspectCommand('标记私聊已读：10001'), { ok: true, action: 'markRead', targetId: 10001 });
});

test('查看转发：缺省 forwardId 空串，id 允许常见符号', () => {
  assert.deepEqual(parseOwnerInspectCommand('看转发'), { ok: true, action: 'forward', forwardId: '' });
  assert.deepEqual(parseOwnerInspectCommand('查看转发'), { ok: true, action: 'forward', forwardId: '' });
  assert.deepEqual(parseOwnerInspectCommand('[查看转发 fwd_abc-123/xy]'), { ok: true, action: 'forward', forwardId: 'fwd_abc-123/xy' });
  assert.deepEqual(parseOwnerInspectCommand('转发详情：12345'), { ok: true, action: 'forward', forwardId: '12345' });
  assert.deepEqual(parseOwnerInspectCommand('转发内容'), { ok: true, action: 'forward', forwardId: '' });
});

test('查看帮助：只读指令用法', () => {
  for (const text of ['查看帮助', '【查看指令】', '只读指令', '查看用法']) {
    assert.deepEqual(parseOwnerInspectCommand(text), { ok: true, action: 'help' }, text);
  }
});

test('普通聊天与非法规格不误判', () => {
  assert.deepEqual(parseOwnerInspectCommand('你好'), { ok: false });
  assert.deepEqual(parseOwnerInspectCommand(''), { ok: false });
  assert.deepEqual(parseOwnerInspectCommand(null), { ok: false });
  assert.deepEqual(parseOwnerInspectCommand('【】'), { ok: false });
  // 13 位不是群号：整条不匹配，而不是截成前 12 位。
  assert.equal(parseOwnerInspectCommand('群公告 1234567890123').ok, false);
});

// ── 2. 今日用量 ───────────────────────────────────────────────────────────

test('今日用量：只算当天 turn，昨天/base/evict 不计入', () => {
  const records = [
    // 昨天（北京时间 23:30）的 turn：不能计入今天
    { k: 'turn', t: at('2026-10-19T23:30:00+08:00'), model: 'deepseek-pro', key: 'group:yesterday', b: { cacheMiss: 900000, output: 900000 } },
    // 今天但 k 不是 turn：是历史累计，计入就会重复计费
    { k: 'base', t: at('2026-10-20T09:00:00+08:00'), model: 'deepseek-flash', key: 'base:1', b: { cacheMiss: 800000, output: 800000 } },
    { k: 'evict', t: at('2026-10-20T09:10:00+08:00'), model: 'deepseek-flash', key: 'evict:1', b: { cacheMiss: 700000 } },
    // 今天 09:30（高峰时段，2 倍价）
    { k: 'turn', t: at('2026-10-20T09:30:00+08:00'), model: 'deepseek-flash', key: 'private:10001', b: { cacheHit: 2000, cacheMiss: 1000, output: 500, reasoning: 100 } },
    // 今天 20:00（空闲时段），用 DSH 原始键名验证的兼容性
    { k: 'turn', t: at('2026-10-20T20:00:00+08:00'), model: 'deepseek-pro', key: 'group:222', b: { inputTokens: 3000, outputTokens: 1000 } }
  ];
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n{bad json';

  const text = formatTodayUsage(jsonl, { now: NOW });
  assert.match(text, /【今日用量】/);
  assert.match(text, /北京日期：2026-10-20 · 生成时刻：14:05/);
  assert.match(text, /总 token：7,500/);
  assert.match(text, /输入：6,000（命中 2,000 \/ 未命中 4,000 \/ 写入 0）/);
  assert.match(text, /输出：1,500（其中推理 100/);
  // 0.00608（flash 高峰）+ 0.027（pro 空闲）= 0.03308 → ¥0.0331
  assert.match(text, /估算花费：¥0\.0331/);
  assert.doesNotMatch(text, /含估算价/);
  assert.match(text, /DeepSeek-V4\.1-Flash（deepseek-flash）/);
  assert.match(text, /DeepSeek-V4-Pro-0813（旧模型名）（deepseek-pro）/);
  assert.match(text, /private:10001：3,500 token · ¥0\.0061/);
  assert.match(text, /group:222：4,000 token · ¥0\.0270/);
  // 昨天、基线、淘汰汇总的 key 都不能出现
  assert.doesNotMatch(text, /group:yesterday/);
  assert.doesNotMatch(text, /base:1/);
  assert.doesNotMatch(text, /evict:1/);
});

test('今日用量：数组输入与非 turn 记录', () => {
  const text = formatTodayUsage([
    { k: 'turn', t: NOW, model: 'deepseek-flash', key: 'private:1', b: { cacheMiss: 1000, output: 1000 } }
  ], { now: NOW });
  assert.match(text, /总 token：2,000/);
  assert.match(text, /private:1/);

  const onlyBase = formatTodayUsage([{ k: 'base', t: NOW, b: { cacheMiss: 999 } }], { now: NOW });
  assert.equal(onlyBase, '今日还没有用量记录。');
});

test('今日用量：空数据与坏数据', () => {
  for (const raw of ['', '   ', 'not json\n', '[]', [], null, undefined]) {
    assert.equal(formatTodayUsage(raw, { now: NOW }), '今日还没有用量记录。');
  }
});

test('今日用量：未知模型提示含估算价，空 key 显示未归属', () => {
  const text = formatTodayUsage([
    { k: 'turn', t: NOW, model: 'some-unknown-model', key: '', b: { cacheMiss: 1000, output: 100 } }
  ], { now: NOW });
  assert.match(text, /some-unknown-model/);
  assert.match(text, /未收录，含估算价/);
  assert.match(text, /估算花费：.*（含估算价）/);
  assert.match(text, /未归属/);
});

test('今日用量：小于 ¥0.0001 显示 <¥0.0001', () => {
  // 空闲时段命中价 0.02/M：100 token = 0.000002 元
  const text = formatTodayUsage([
    { k: 'turn', t: at('2026-10-20T20:00:00+08:00'), model: 'deepseek-flash', key: 'k', b: { cacheHit: 100 } }
  ], { now: NOW });
  assert.match(text, /估算花费：<¥0\.0001/);
});

// ── 3. 服务器 ─────────────────────────────────────────────────────────────

test('服务器统计：负载/内存/磁盘/运行时长', () => {
  const text = formatServerStats({
    loadavg: [0.5, 0.4, 0.3],
    cpuCount: 4,
    totalmem: 16 * 1024 ** 3,
    freemem: 6 * 1024 ** 3,
    statfs: { bsize: 4096, blocks: 1000000, bavail: 250000 },
    processUptimeSec: 90061,
    hostUptimeSec: 191220,
    now: NOW
  });
  assert.match(text, /【服务器】/);
  assert.match(text, /负载：0\.50 \/ 0\.40 \/ 0\.30（1\/5\/15 分钟）/);
  assert.match(text, /CPU：4 核（1 分钟负载低于核数）/);
  assert.match(text, /内存：10\.0 \/ 16\.0 GB（62\.5%）/);
  assert.match(text, /磁盘（仅该分区）：2\.9 \/ 3\.8 GB（75\.0%）/);
  assert.match(text, /桥接运行时长：1天1小时1分/);
  assert.match(text, /主机运行时长：2天5小时7分/);
});

test('服务器统计：空对象全部未知且不抛异常', () => {
  const text = formatServerStats();
  assert.match(text, /【服务器】/);
  assert.match(text, /负载：未知 \/ 未知 \/ 未知/);
  assert.match(text, /CPU：未知/);
  assert.match(text, /内存：未知/);
  assert.match(text, /磁盘：未知/);
  assert.match(text, /桥接运行时长：未知/);
  assert.match(text, /主机运行时长：未知/);
});

// ── 4. 群信息 / 群公告 ────────────────────────────────────────────────────

test('群信息：正常字段（秒级创建时间按北京时间）', () => {
  const text = formatGroupInfo(7000001, {
    group_name: '测试群',
    member_count: 45,
    max_member_count: 200,
    owner_id: 10001,
    create_time: 1577900000,
    group_all_shut: 0
  });
  assert.match(text, /【群信息】7000001/);
  assert.match(text, /群名称：测试群/);
  assert.match(text, /成员：45 \/ 200/);
  assert.match(text, /群主：10001/);
  assert.match(text, /创建时间：2020-01-02 01:33/);
  assert.match(text, /全员禁言：关闭/);
});

test('群信息：别名字段 + 毫秒级创建时间', () => {
  const text = formatGroupInfo(1, {
    name: '别名群',
    owner_uin: 20002,
    group_create_time: 1577900000123,
    all_shut: 1
  });
  assert.match(text, /群名称：别名群/);
  assert.match(text, /群主：20002/);
  assert.match(text, /创建时间：2020-01-02 01:33/);
  assert.match(text, /全员禁言：开启/);
});

test('群信息：空数据返回读取失败样式', () => {
  for (const data of [null, undefined, {}, 'x']) {
    const text = formatGroupInfo(12345, data);
    if (data && typeof data === 'object') {
      assert.match(text, /群名称：未知/);
      assert.match(text, /成员：未知 \/ 未知/);
      assert.match(text, /全员禁言：未知/);
    } else {
      assert.match(text, /读取群信息失败/);
    }
  }
});

test('群公告：数组形状（正文、时间、发布者、类型、图片数）', () => {
  const text = formatGroupNotice(7000001, [
    {
      publisher_id: 10001,
      publish_time: Math.floor(NOW / 1000),
      notice_type: '群公告',
      message: { text: '第一则公告', images: [{ file: 'a.png' }, { file: 'b.png' }] }
    },
    {
      sender_id: 10002,
      publish_time: Math.floor(NOW / 1000) - 60,
      notice_type: '新成员',
      text: '欢迎新成员',
      image: 'https://example.com/1.png'
    }
  ]);
  assert.match(text, /【群公告】7000001/);
  assert.match(text, /1\. 2026-10-20 14:05 · QQ 10001 · 群公告/);
  assert.match(text, /第一则公告/);
  assert.match(text, /图片 2 张/);
  assert.match(text, /2\. 2026-10-20 14:04 · QQ 10002 · 新成员公告/);
  assert.match(text, /欢迎新成员/);
  assert.match(text, /图片 1 张/);
});

test('群公告：{notices} 形状 + 字段缺失容错', () => {
  const text = formatGroupNotice(1, { notices: [{ text: '包起来的公告' }] });
  assert.match(text, /包起来的公告/);
  assert.match(text, /时间未知/);
  assert.match(text, /QQ 未知/);
  assert.match(text, /群公告/);
});

test('群公告：无公告与超长正文截断', () => {
  assert.equal(formatGroupNotice(1, { notices: [] }), '群 1 暂无公告。');
  assert.equal(formatGroupNotice(1, null), '群 1 暂无公告。');
  const long = formatGroupNotice(1, [{ text: '长'.repeat(260) }]);
  assert.match(long, /…/);
  assert.equal(long.includes('长'.repeat(201)), false);
});

// ── 4.5 群荣誉 / @全体剩余 ────────────────────────────────────────────────

test('群荣誉：当前龙王去重、各榜单与描述', () => {
  const text = formatGroupHonor(7000001, {
    group_id: 7000001,
    current_talkative: { user_id: 10001, nickname: '龙王甲', description: '连续 7 天' },
    talkative_list: [
      { user_id: 10001, nickname: '龙王甲', description: '连续 7 天' },
      { user_id: 10002, nickname: '龙王乙', description: '连续 3 天' }
    ],
    performer_list: [{ user_id: 10003, nickname: '小火', description: '群聊之火' }],
    legend_list: [],
    emotion_list: [{ user_id: 10004, nickname: '开心果' }],
    strong_newbie_list: []
  });
  assert.match(text, /【群荣誉】7000001/);
  assert.match(text, /当前龙王：龙王甲\(10001\)｜连续 7 天/);
  assert.match(text, /龙王（1）：/);
  assert.match(text, /1\. 龙王乙\(10002\)｜连续 3 天/);
  // 当前龙王不应在「龙王」列表里重复出现。
  assert.equal((text.match(/龙王甲\(10001\)/g) || []).length, 1);
  assert.match(text, /群聊之火（1）：/);
  assert.match(text, /1\. 小火\(10003\)｜群聊之火/);
  assert.match(text, /快乐源泉（1）：/);
  assert.doesNotMatch(text, /冒泡新星/);
});

test('群荣誉：空榜单/空数据/非法数据', () => {
  const empty = formatGroupHonor(1, {
    current_talkative: null,
    talkative_list: [],
    performer_list: [],
    legend_list: [],
    emotion_list: [],
    strong_newbie_list: []
  });
  assert.match(empty, /暂无荣誉数据/);

  for (const bad of [null, undefined, [], 'x']) {
    assert.match(formatGroupHonor(1, bad), /读取群荣誉失败/);
  }
});

test('群荣誉：单榜超过上限时截断并提示', () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ user_id: 10000 + i, nickname: `成员${i}` }));
  const text = formatGroupHonor(1, { talkative_list: list }, { perSection: 2 });
  assert.match(text, /只显示前 2 位/);
  assert.doesNotMatch(text, /成员2/);
});

test('@全体剩余：正常字段与空字段', () => {
  const text = formatAtAllRemain(7000001, {
    can_at_all: true,
    remain_at_all_count_for_group: 19,
    remain_at_all_count_for_uin: 10
  });
  assert.equal(text, [
    '【@全体剩余】群 7000001',
    '可@全体：是',
    '群剩余次数：19',
    '我的剩余次数：10'
  ].join('\n'));

  const zero = formatAtAllRemain(1, {
    can_at_all: false,
    remain_at_all_count_for_group: 0,
    remain_at_all_count_for_uin: 0
  });
  assert.match(zero, /可@全体：否/);
  assert.match(zero, /群剩余次数：0/);
  assert.match(zero, /我的剩余次数：0/);

  const unknown = formatAtAllRemain(1, null);
  assert.match(unknown, /可@全体：未知/);
  assert.match(unknown, /群剩余次数：未知/);
  assert.match(unknown, /我的剩余次数：未知/);
});

// ── 5. 标记已读 ───────────────────────────────────────────────────────────

test('标记已读：成功（负数 latestId 原样保留）', () => {
  const text = formatMarkReadResult({ kind: 'group', targetId: 123456, latestId: -5, unread: 3 });
  assert.equal(text, '已标记已读｜群 123456｜最新消息 #-5｜本地未读 3 条');
});

test('标记已读：unread 未知时省略，字符串 latestId 保留', () => {
  const text = formatMarkReadResult({ targetId: 10001, latestId: 'abc', unread: null });
  assert.equal(text, '已标记已读｜私聊 10001｜最新消息 #abc');
});

test('标记已读：失败', () => {
  assert.equal(formatMarkReadResult({ ok: false, error: '权限不足' }), '标记已读失败：权限不足');
  assert.equal(formatMarkReadResult({ ok: false }), '标记已读失败：未知错误');
});

// ── 6. 转发摘要 ───────────────────────────────────────────────────────────

const forwardData = {
  messages: [
    {
      sender: { nickname: '张三', user_id: 10001 },
      time: Math.floor(NOW / 1000),
      message: [{ type: 'text', data: { text: '第一句' } }]
    },
    {
      sender: { card: '李四', user_id: 10002 },
      time: Math.floor(NOW / 1000),
      message: '第二句'
    }
  ]
};

test('转发摘要：正常两条', () => {
  const text = formatForwardSummary(forwardData);
  assert.match(text, /【转发内容】共 2 条/);
  assert.match(text, /1\. 14:05 张三\(10001\)：第一句/);
  assert.match(text, /2\. 14:05 李四\(10002\)：第二句/);
  assert.doesNotMatch(text, /只显示前/);
});

test('转发摘要：条数上限与文本截断标记', () => {
  const limited = formatForwardSummary(forwardData, { maxNodes: 1 });
  assert.match(limited, /只显示前 1 条/);
  assert.doesNotMatch(limited, /第二句/);

  const short = formatForwardSummary(forwardData, { maxChars: 2 });
  assert.match(short, /张三\(10001\)：第一…/);
});

test('转发摘要：空数据', () => {
  assert.equal(formatForwardSummary(null), '没有读取到转发内容。');
  assert.equal(formatForwardSummary([]), '没有读取到转发内容。');
  assert.equal(formatForwardSummary({ messages: [] }), '没有读取到转发内容。');
});

console.log(`owner-inspect tests: ${passed} passed`);
