#!/usr/bin/env node
// owner 主动/限额/定时/表情回应 + 目标名解析：VM harness 集成测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { PROACTIVE_TOPIC_SEEDS } from '../src/proactive-topics.js';

const OWNER = 123;
const GROUP = 7000001;
const FRIEND = 7770486;

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

bridge.calls.groups = [
  { group_id: GROUP, group_name: '测试群聊' },
  { group_id: 7000002, group_name: '另一个群' },
  { group_id: 7000003, group_name: '重名群' },
  { group_id: 7000004, group_name: '重名群' }
];
bridge.calls.groupMembers = [
  { user_id: FRIEND, nickname: '示例好友甲', card: '示例好友甲', role: 'member' }
];
bridge.calls.qzoneFriends = [
  { user_id: FRIEND, remark: '示例好友甲', nickname: '示例昵称' }
];

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

await test('消息表情回应：调用 set_msg_emoji_like', async () => {
  calls.emojiLikes.length = 0;
  const reply = await cmd('[消息表情回应][-123456789][76]');
  assert.match(reply, /已给消息 -123456789 添加表情回应 76/);
  assert.equal(calls.emojiLikes.length, 1);
  assert.equal(calls.emojiLikes[0].message_id, -123456789);
  assert.equal(calls.emojiLikes[0].emoji_id, '76');
  assert.equal(calls.emojiLikes[0].set, true);

  const cancel = await cmd('[取消表情回应][-123456789][76]');
  assert.match(cancel, /已取消消息 -123456789 的表情回应 76/);
  assert.equal(calls.emojiLikes[1].set, false);
});

await test('主动唤醒：群名解析并投递主动机会', async () => {
  calls.prompts.length = 0;
  const reply = await cmd('[主动唤醒][测试群聊]');
  assert.match(reply, /已唤醒 测试群聊/);
  assert.ok(calls.prompts.length >= 1, '应投递唤醒提示');
  const prompt = (calls.prompts.at(-1)?.content || []).map((c) => c.text || '').join('');
  assert.match(prompt, /【主动机会/);
  assert.match(prompt, /group:7000001/);
});

await test('主动唤醒：重名群拒绝执行', async () => {
  calls.prompts.length = 0;
  const reply = await cmd('[主动唤醒][重名群]');
  assert.match(reply, /有 2 个群匹配/);
  assert.match(reply, /7000003/);
  assert.match(reply, /7000004/);
  assert.equal(calls.prompts.length, 0);
});

await test('主动对话：群名 + 内容投递 ownerTask', async () => {
  // 上一条主动唤醒还在途：退役会话以清掉 busy 标记，并清掉唤醒频率计数。
  bridge.retireSession(`group:${GROUP}`, 'test');
  bridge.getSocialV2State(`group:${GROUP}`).wakeTimes = [];
  calls.prompts.length = 0;
  const reply = await cmd('[主动对话][测试群聊][说一句 晚安]');
  assert.match(reply, /已让 测试群聊/);
  assert.ok(calls.prompts.length >= 1);
  const prompt = (calls.prompts.at(-1)?.content || []).map((c) => c.text || '').join('');
  assert.match(prompt, /【管理员任务/);
  assert.match(prompt, /说一句 晚安/);
});

await test('主动问候开关：状态/关闭/开启/3天暂停', async () => {
  const key = `group:${GROUP}`;
  const st = bridge.getSocialV2State(key);
  st.lastIncomingAt = Date.now() - 2 * 3600000;
  st.proactiveGreetingEnabled = true;

  let reply = await cmd('[主动状态][测试群聊]');
  assert.match(reply, /【主动问候】/);
  assert.match(reply, /开关：开启/);
  assert.match(reply, /当前状态：正常/);

  reply = await cmd('[关闭主动][测试群聊]');
  assert.match(reply, /已关闭/);
  assert.equal(st.proactiveGreetingEnabled, false);

  reply = await cmd('[主动状态][测试群聊]');
  assert.match(reply, /开关：关闭/);
  assert.match(reply, /已关闭（手动）/);

  reply = await cmd('[主动开关][测试群聊][on]');
  assert.match(reply, /已开启/);
  assert.equal(st.proactiveGreetingEnabled, true);

  st.lastIncomingAt = Date.now() - 4 * 86400000;
  reply = await cmd('[主动状态][测试群聊]');
  assert.match(reply, /已暂停（超过 3 天没对话）/);

  await cmd('[关闭主动][测试群聊]');
  reply = await cmd('[开启主动][测试群聊]');
  assert.match(reply, /仍会自动暂停/);

  // 恢复现场，避免影响后续用例。
  st.lastIncomingAt = Date.now();
  st.proactiveGreetingEnabled = true;
});

await test('限额调整：查看与写入 config.json', async () => {
  let reply = await cmd('[限额调整]');
  assert.match(reply, /【发送限额】/);
  assert.match(reply, /私聊：每分钟 10/);

  reply = await cmd('[限额调整][私聊][每分钟][5]');
  assert.match(reply, /私聊限额的每分钟改为 5/);
  assert.equal(bridge.cfg.sendLimits.private.perMinute, 5);
  let saved = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.equal(saved.sendLimits.private.perMinute, 5);

  reply = await cmd('[限额调整][群聊][20/200/500]');
  assert.match(reply, /群聊限额改为：每分钟 20/);
  assert.equal(bridge.cfg.sendLimits.group.perHour, 200);
  saved = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.equal(saved.sendLimits.group.perDay, 500);
});

await test('限额重置：清掉目标今天的发送计数，保留昨天', async () => {
  const key = `group:${GROUP}`;
  const st = bridge.getSocialV2State(key);
  const now = Date.now();
  st.sendTimes = [now, now - 1000, now - 26 * 3600 * 1000];
  const reply = await cmd('[限额重置][测试群聊]');
  assert.match(reply, /已重置 测试群聊/);
  assert.match(reply, /移除 2 条/);
  assert.equal(st.sendTimes.length, 1, '昨天的记录应保留');
  assert.ok(now - st.sendTimes[0] > 24 * 3600 * 1000);
});

await test('指令帮助：默认发目录，按序号/全部分段', async () => {
  const index = await cmd('[指令]');
  assert.match(index, /【指令总览】/);
  assert.ok(index.length < 1500, `目录过长 ${index.length}`);
  assert.match(index, /\[指令 序号\]/);

  const section = await cmd('[指令 1]');
  assert.match(section, /【指令 1\//);
  assert.match(section, /好友动态查询/);

  const all = await cmd('[指令 全部]');
  assert.match(all, /【指令 全部 1\//);
  assert.match(all, /管理员操作/);
  assert.ok(calls.sent.length >= 2, '全部帮助应分多条发送');

  const invalid = await cmd('[指令 999]');
  assert.match(invalid, /【指令总览】/);
});

await test('定时任务：创建/查看/取消', async () => {
  const reply = await cmd('[定时任务][明天早上8点][测试群聊][用语音打招呼说早安]');
  assert.match(reply, /已创建定时任务 r_/);
  assert.match(reply, /→ 测试群聊/);

  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'state', 'reminders.json'), 'utf8'));
  const list = saved[`group:${GROUP}`];
  assert.ok(Array.isArray(list) && list.length >= 1);
  const item = list.find((r) => r.kind === 'ownerTask');
  assert.ok(item, '应有 ownerTask');
  assert.equal(item.text, '用语音打招呼说早安');
  assert.ok(item.at > Date.now());

  const shown = await cmd('[定时任务][查看所有]');
  assert.match(shown, /【定时任务】/);
  assert.match(shown, /用语音打招呼说早安/);
  assert.match(shown, /→ 测试群聊/);

  const cancel = await cmd('[定时任务][取消 1]');
  assert.match(cancel, /已取消定时任务/);
  const after = JSON.parse(fs.readFileSync(path.join(temp, 'state', 'reminders.json'), 'utf8'));
  assert.equal((after[`group:${GROUP}`] || []).filter((r) => r.kind === 'ownerTask').length, 0);
});

await test('定时任务：重复 + 次数限制 + 全部取消确认', async () => {
  const reply = await cmd('[定时任务][每天8点][测试群聊][说早安][连续2天]');
  assert.match(reply, /已创建定时任务 r_/);
  assert.match(reply, /每天 08:00/);
  assert.match(reply, /共 2 次/);

  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'state', 'reminders.json'), 'utf8'));
  const item = (saved[`group:${GROUP}`] || []).find((r) => r.kind === 'ownerTask');
  assert.equal(item.repeat, 'daily');
  assert.equal(item.remaining, 2);

  const shown = await cmd('[定时任务][查看所有]');
  assert.match(shown, /每天 08:00/);
  assert.match(shown, /剩 2 次/);

  const noConfirm = await cmd('[定时任务][取消 全部]');
  assert.match(noConfirm, /危险操作/);
  assert.equal((JSON.parse(fs.readFileSync(path.join(temp, 'state', 'reminders.json'), 'utf8'))[`group:${GROUP}`] || [])
    .filter((r) => r.kind === 'ownerTask').length, 1);

  const all = await cmd('[定时任务][取消 全部 确认]');
  assert.match(all, /已取消全部 1 条/);
  assert.equal((JSON.parse(fs.readFileSync(path.join(temp, 'state', 'reminders.json'), 'utf8'))[`group:${GROUP}`] || [])
    .filter((r) => r.kind === 'ownerTask').length, 0);
});

await test('定时任务：时间听不懂时明确报错', async () => {
  const reply = await cmd('[定时任务][随便什么时候][测试群聊][说早安]');
  assert.match(reply, /时间没听懂/);
});

await test('查询模型余额：DeepSeek 真实接口（fixture）', async () => {
  const reply = await cmd('[查询模型余额][deepseek]');
  assert.match(reply, /【DeepSeek 余额】/);
  assert.match(reply, /27\.45/);
});

await test('查询模型余额：千问/豆包说明无 key 余额接口', async () => {
  let reply = await cmd('[查询模型余额]');
  assert.match(reply, /【查询模型余额】/);
  assert.match(reply, /DeepSeek：/);

  reply = await cmd('[查询模型余额][千问]');
  assert.match(reply, /千问\/百炼 余额/);
  assert.match(reply, /没有基于 API key 的余额查询接口/);

  reply = await cmd('[查询模型余额][豆包]');
  assert.match(reply, /豆包\/火山方舟 余额/);

  reply = await cmd('[查询模型余额][不存在的模型]');
  assert.match(reply, /没认出模型/);
});

await test('管理指令支持群名/成员名', async () => {
  calls.groupSigns.length = 0;
  let reply = await cmd('[群签到][测试群聊]');
  assert.match(reply, /完成签到/);
  assert.equal(calls.groupSigns.at(-1).group_id, GROUP);

  calls.specialTitles.length = 0;
  reply = await cmd('[群头衔][测试群聊][示例好友甲][摸鱼达人][确认]');
  assert.match(reply, /头衔改为「摸鱼达人」/);
  assert.equal(calls.specialTitles.at(-1).group_id, GROUP);
  assert.equal(calls.specialTitles.at(-1).user_id, FRIEND);
  assert.equal(calls.specialTitles.at(-1).special_title, '摸鱼达人');
});

await test('只读指令支持群名', async () => {
  const reply = await cmd('[群信息][测试群聊]');
  assert.match(reply, new RegExp(`【群信息】${GROUP}`));
  assert.match(reply, /群名称：fixture-group/);
});

await test('好友名解析：主动对话到好友', async () => {
  const b2 = await bridgeHarness({
    config: {
      consolePort: 0,
      allow: { private: [String(OWNER), String(FRIEND)], groups: [] }
    }
  });
  try {
    b2.calls.qzoneFriends = [{ user_id: FRIEND, remark: '示例好友甲', nickname: '示例昵称' }];
    b2.setMode('reserved2');
    b2.calls.sent.length = 0;
    await b2.handleIncoming('private', OWNER, {
      user_id: OWNER,
      self_id: 1,
      message_id: String(Date.now()),
      message: [{ type: 'text', data: { text: '[主动对话][示例好友甲][说早安]' } }],
      raw_message: '[主动对话][示例好友甲][说早安]'
    }, b2.cfg);
    const reply = b2.calls.sent.map((m) => m.text).join('\n');
    assert.match(reply, /已让 示例好友甲（私聊 7770486）/);
    assert.ok(b2.calls.prompts.length >= 1);
    const prompt = (b2.calls.prompts.at(-1)?.content || []).map((c) => c.text || '').join('');
    assert.match(prompt, /【管理员任务/);
    assert.match(prompt, /private:7770486/);
  } finally {
    await b2.close();
  }
});

await test('主动开口：话题方向轮换写入提示词', async () => {
  const b5 = await bridgeHarness({
    config: { consolePort: 0, allow: { private: [String(OWNER)], groups: [String(GROUP)] } }
  });
  try {
    b5.setMode('reserved2');
    const key = `group:${GROUP}`;
    const st = b5.getSocialV2State(key);
    st.proactiveTopicIndex = 0;
    st.wakeTimes = [];
    b5.calls.prompts.length = 0;

    let result = await b5.sendWakePromptV2(key, 'proactiveCheck');
    assert.equal(result.ok, true);
    let prompt = (b5.calls.prompts.at(-1)?.content || []).map((c) => c.text || '').join('');
    assert.match(prompt, /【本次主动方向】/);
    assert.ok(prompt.includes(PROACTIVE_TOPIC_SEEDS[0].label), '应包含第 1 个方向');
    assert.match(prompt, /不要主动提猫\/宠物/);
    assert.equal(st.proactiveTopicIndex, 1);

    // 清 busy / 唤醒频率后第二次，方向应轮换。
    b5.retireSession(key, 'test');
    b5.getSocialV2State(key).wakeTimes = [];
    b5.calls.prompts.length = 0;
    result = await b5.sendWakePromptV2(key, 'proactiveCheck');
    assert.equal(result.ok, true);
    prompt = (b5.calls.prompts.at(-1)?.content || []).map((c) => c.text || '').join('');
    assert.ok(prompt.includes(PROACTIVE_TOPIC_SEEDS[1].label), '应轮换到第 2 个方向');
    assert.equal(st.proactiveTopicIndex, 2);
  } finally {
    await b5.close();
  }
});

await test('发送限额：分钟上限生效，限额重置后可继续发送', async () => {
  const b3 = await bridgeHarness({
    config: {
      consolePort: 0,
      ownerQQ: FRIEND,
      allow: { private: [String(FRIEND)], groups: [] },
      sendLimits: { private: { perMinute: 1, perHour: 100, perDay: 100 } }
    }
  });
  let server = null;
  try {
    b3.setMode('reserved2');
    const key = `private:${FRIEND}`;
    const st = b3.getSocialV2State(key);
    server = b3.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

    const send = (messages) => new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/api/socialV2/send-burst',
        method: 'POST',
        headers: {
          'x-console-token': 'fixture-console-token',
          'x-agent-token': st.agentToken,
          'content-type': 'application/json'
        }
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw || '{}') }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
      req.end(JSON.stringify({ key, messages }));
    });

    const first = await send(['第一条']);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await send(['第二条']);
    assert.equal(second.status, 429);
    assert.match(second.data.error, /每分钟最多 1 条/);

    // 用 owner 指令重置该会话今天的计数。
    b3.calls.sent.length = 0;
    await b3.handleIncoming('private', FRIEND, {
      user_id: FRIEND,
      self_id: 1,
      message_id: String(Date.now()),
      message: [{ type: 'text', data: { text: `[限额重置][${FRIEND}]` } }],
      raw_message: `[限额重置][${FRIEND}]`
    }, b3.cfg);
    const reply = b3.calls.sent.map((m) => m.text).join('\n');
    assert.match(reply, /已重置/);

    const third = await send(['第三条']);
    assert.equal(third.status, 200, JSON.stringify(third.data));
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await b3.close();
  }
});

await bridge.close();
console.log(`\nowner-actions bridge tests: ${passed} passed`);
