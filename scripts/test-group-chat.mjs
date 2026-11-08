#!/usr/bin/env node
// 群聊现场块、上下文快照、活跃度预算的离线测试。
// 一部分是纯函数；一部分用 bridge harness（假 DSH/SnowLuma，不联网、不发 QQ）。
import assert from 'node:assert/strict';
import {
  applyGroupProbabilityFloor,
  buildGroupChatBlockV2,
  countReplyTurns,
  messagePreview,
  repeatOpenerWarning,
  speakerLabel,
  threadTail
} from '../src/group-chat.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

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

// ── 纯函数 ──────────────────────────────────────────────────────────────

await test('speakerLabel: 同名不同 userId 加尾号，唯一名字不加', () => {
  const all = [
    { sender: '小明', userId: '1001234' },
    { sender: '小明', userId: '2005678' },
    { sender: '小红', userId: '3009999' }
  ];
  assert.equal(speakerLabel(all[0], all), '小明（尾号1234）');
  assert.equal(speakerLabel(all[2], all), '小红');
  assert.equal(speakerLabel({ sender: '无ID' }, all), '无ID');
});

await test('threadTail: 只取最近 3 条非自己、窗口内的消息', () => {
  const now = Date.now();
  const messages = [
    { sender: 'A', text: '太旧了', time: now - 20 * 60 * 1000 },
    { sender: 'A', text: '第一句', time: now - 3000 },
    { sender: '樱良', text: '自己说的', isSelf: true, time: now - 2000 },
    { sender: 'B', text: '第二句', time: now - 1000 },
    { sender: 'A', text: '第三句', time: now - 500 }
  ];
  const tail = threadTail(messages, 3, now);
  assert.deepEqual(tail.map((item) => item.text), ['第一句', '第二句', '第三句']);
});

await test('messagePreview: 压成一行并截断', () => {
  assert.equal(messagePreview({ text: 'a\n\nb   c' }, 20), 'a b c');
  assert.equal(messagePreview({ text: '一二三四五六' }, 4), '一二三四…');
});

await test('repeatOpenerWarning: 连续相同开头会提示', () => {
  const self = [
    { isSelf: true, text: '哈哈哈哈这也行' },
    { isSelf: true, text: '哈哈哈哈确实' },
    { isSelf: true, text: '不过说真的' }
  ];
  assert.equal(repeatOpenerWarning(self), '哈哈哈哈');
  assert.equal(repeatOpenerWarning([{ isSelf: true, text: '好的' }, { isSelf: true, text: '嗯嗯' }]), null);
});

await test('countReplyTurns: 连续自己消息算一轮，被别人隔开算两轮', () => {
  const now = Date.now();
  const messages = [
    { sender: 'A', text: 'x', time: now - 9 * 60 * 1000 },
    { sender: '樱良', text: 'r1', isSelf: true, time: now - 8.9 * 60 * 1000 },
    { sender: '樱良', text: 'r2', isSelf: true, time: now - 8.8 * 60 * 1000 },
    { sender: 'B', text: 'y', time: now - 8 * 60 * 1000 },
    { sender: '樱良', text: 'r3', isSelf: true, time: now - 7 * 60 * 1000 }
  ];
  assert.equal(countReplyTurns(messages, now, 10 * 60 * 1000, 2 * 60 * 1000), 2);
});

await test('buildGroupChatBlockV2: soft 变体包含现场、示范、人格锚点和隐私边界', () => {
  const now = Date.now();
  const recent = [
    { sender: 'A', text: '这也太离谱了', time: now - 3000, userId: '1' },
    { sender: 'B', text: '我上次也遇到过', time: now - 2000, userId: '2' },
    { sender: 'A', text: '笑死', time: now - 1000, userId: '1' }
  ];
  const block = buildGroupChatBlockV2({ reason: 'anyMessage', now, recentMessages: recent, unreadCount: 3 });
  assert.match(block, /【群聊现场/);
  assert.match(block, /没人点你/);
  assert.match(block, /最近话头：A「这也太离谱了」/);
  assert.match(block, /接最后一句/);
  assert.match(block, /不是 AI\/客服/);
  assert.match(block, /私聊内容/);
});

await test('buildGroupChatBlockV2: direct / initiate / serious / followup 变体', () => {
  const now = Date.now();
  const recent = [{ sender: 'A', text: '在吗', time: now - 1000, userId: '1' }];
  const direct = buildGroupChatBlockV2({ reason: 'atMention', now, recentMessages: recent, unreadCount: 1 });
  assert.match(direct, /有人点你/);
  assert.match(direct, /先回他/);
  const initiate = buildGroupChatBlockV2({ reason: 'proactiveCheck', now, recentMessages: recent, unreadCount: 0 });
  assert.match(initiate, /主动开口/);
  const serious = buildGroupChatBlockV2({ reason: 'encyclopedia', now, recentMessages: recent, unreadCount: 1 });
  assert.match(serious, /先答问题/);
  const followup = buildGroupChatBlockV2({ reason: 'followup', now, recentMessages: recent, unreadCount: 1 });
  assert.match(followup, /到点/);
});

await test('buildGroupChatBlockV2: enabled=false 返回空串，长度受 maxChars 限制', () => {
  assert.equal(buildGroupChatBlockV2({ enabled: false, reason: 'anyMessage' }), '');
  const block = buildGroupChatBlockV2({ reason: 'anyMessage', maxChars: 200 });
  // truncateCodePoints 保留 maxChars 个字符后再补一个省略号。
  assert.ok(Array.from(block).length <= 201);
});

await test('applyGroupProbabilityFloor: 群聊 0.05 抬到 0.15，显式 0 和私聊不动', () => {
  assert.equal(applyGroupProbabilityFloor('group:1', 0.05, 0.15), 0.15);
  assert.equal(applyGroupProbabilityFloor('group:1', 0, 0.15), 0);
  assert.equal(applyGroupProbabilityFloor('group:1', 0.2, 0.15), 0.2);
  assert.equal(applyGroupProbabilityFloor('private:1', 0.05, 0.15), 0.05);
});

await test('buildGroupChatBlockV2: 重复开头与预算提示', () => {
  const now = Date.now();
  const recent = [
    { sender: '樱良', isSelf: true, text: '哈哈哈哈一', time: now - 3000 },
    { sender: '樱良', isSelf: true, text: '哈哈哈哈二', time: now - 2000 }
  ];
  const block = buildGroupChatBlockV2({ reason: 'anyMessage', now, recentMessages: recent, budget: { nearLimit: true } });
  assert.match(block, /开头有点重复/);
  assert.match(block, /发言预算/);
});

// ── bridge harness ─────────────────────────────────────────────────────

const bridge = await bridgeHarness({
  config: {
    socialV2: {
      group: {
        blockEnabled: true,
        blockMaxChars: 900,
        context: {
          wakeMessageLimit: 16,
          wakeRecentLimit: 8,
          wakeLatestLimit: 6,
          wakeMaxChars: 9000,
          unreadLimit: 60
        },
        wake: { recommendedProbability: 0.2, maxWakePerHour: 18, maxWakePerMinute: 1 },
        activity: {
          enabled: true,
          minReplyGapMs: 90000,
          replyWindowMs: 600000,
          maxRepliesPerWindow: 3,
          turnClusterMs: 120000
        }
      }
    }
  }
});

function addIncoming(key, items) {
  for (const item of items) {
    bridge.appendSocialV2Message(key, item.sender, item.text, item.text, false, false, item.id || '', [], item.userId ?? null);
  }
}

await test('buildWakePromptV2: 群聊注入群聊块，私聊不注入且用私聊措辞', async () => {
  addIncoming('group:456', [
    { sender: 'A', text: '今天好热', id: 'g1', userId: '1' },
    { sender: 'B', text: '是啊，空调都不管用', id: 'g2', userId: '2' }
  ]);
  addIncoming('private:123', [{ sender: '主人', text: '在吗', id: 'p1', userId: '123' }]);
  const groupPrompt = await bridge.buildWakePromptV2('group:456', 'anyMessage');
  const privatePrompt = await bridge.buildWakePromptV2('private:123', 'private');
  assert.match(groupPrompt, /【群聊现场/);
  assert.doesNotMatch(privatePrompt, /【群聊现场/);
  assert.match(privatePrompt, /这是私聊/);
  assert.doesNotMatch(privatePrompt, /群聊正热/);
  assert.match(groupPrompt, /web-search-safe__web_search/);
  assert.match(groupPrompt, /不要编新闻/);
  assert.match(groupPrompt, /一轮最多发 2-3 条/);
  assert.doesNotMatch(privatePrompt, /不要编新闻/);
});

await test('evaluateWakeTriggerV2: anyMessage=true 时 @ 仍返回 atMention', () => {
  const st = bridge.getSocialV2State('group:456');
  st.wakeConfig.triggers.anyMessage = true;
  st.wakeConfig.triggers.atMention = true;
  const event = {
    self_id: 1,
    user_id: 1001,
    sender: { card: 'A', user_id: 1001 },
    message: [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' 在吗' } }]
  };
  const reason = bridge.evaluateWakeTriggerV2('group:456', st, event, 'group', '@樱良 在吗', '@樱良 在吗', false);
  assert.equal(reason, 'atMention');
});

await test('resetWakeConfigV2: active/anyMessage 不被无行动兜底重置回 diving', () => {
  const st = bridge.getSocialV2State('group:456');
  st.wakeConfig.mode = 'active';
  st.wakeConfig.triggers.anyMessage = true;
  bridge.resetWakeConfigV2(st, 'group:456');
  assert.equal(st.wakeConfig.mode, 'active');
  assert.equal(st.wakeConfig.triggers.anyMessage, true);
});

await test('groupSoftWakeAllowedV2: 刚说过话拦概率唤醒，@ 穿透', () => {
  const st = bridge.getSocialV2State('group:456');
  st.lastAiReplyAt = Date.now() - 10000;
  assert.equal(bridge.groupSoftWakeAllowedV2('group:456', st, 'probability', Date.now()), false);
  assert.equal(bridge.groupSoftWakeAllowedV2('group:456', st, 'atMention', Date.now()), true);
});

await test('buildWakeSnapshotV2: 最新现场 latest + droppedCount', () => {
  bridge.cfg.socialV2.group.context.unreadLimit = 5;
  bridge.cfg.socialV2.group.context.wakeMessageLimit = 50;
  const key = 'group:789';
  addIncoming(key, Array.from({ length: 30 }, (_, i) => ({
    sender: i % 2 ? 'A' : 'B',
    text: `m${i}`,
    id: `s${i}`,
    userId: String(i % 2 ? 1 : 2)
  })));
  const snapshot = bridge.buildWakeSnapshotV2(key);
  assert.equal(snapshot.unreadCount, 5);
  assert.equal(snapshot.messages.length, 5);
  assert.equal(snapshot.latest.length, 6);
  assert.equal(snapshot.latest.at(-1).text, 'm29');
  assert.equal(snapshot.droppedCount, 25);
  assert.equal(snapshot.partial, true);
});

await test('隐私：私聊记忆哨兵不进入群聊 prompt', async () => {
  const privateSt = bridge.getSocialV2State('private:123');
  privateSt.activeTopics.push({ text: 'PRIVATE_ONLY_TOPIC_SENTINEL', status: 'open', lastMentionAt: Date.now() });
  const groupPrompt = await bridge.buildWakePromptV2('group:456', 'anyMessage');
  assert.doesNotMatch(groupPrompt, /PRIVATE_ONLY_TOPIC_SENTINEL/);
});

await bridge.close();
console.log(`\n${passed} passed`);
