#!/usr/bin/env node
// social-v2 状态 schema 的 round-trip / 字段覆盖测试。
// 纯函数；不读写生产 state、不调用模型、不需要 DSH/SnowLuma。
import assert from 'node:assert/strict';
import {
  createConversationState,
  serializeConversationState,
  hydrateConversationState,
  PERSISTED_CONVERSATION_KEYS,
  PERSISTED_EXTRA_KEYS,
  EPHEMERAL_CONVERSATION_KEYS
} from '../src/social-state.js';

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

const now = 1_800_000_000_000;
const defaultWakeConfig = {
  mode: 'diving',
  infinite: true,
  sleepUntil: null,
  triggers: { atMention: true, nameMention: true, question: true, probability: 0.05, speakerIds: [] },
  batchWindowMs: 8000
};

function richState() {
  const st = createConversationState({ wakeConfig: { ...defaultWakeConfig, triggers: { ...defaultWakeConfig.triggers } }, agentToken: 'token-a' });
  st.recentMessages = [{ seq: 1, text: 'hi', isSelf: false }];
  st.unread = [{ seq: 1, text: 'hi', isSelf: false }];
  st.lastWakeReason = 'question';
  st.lastAiReplyAt = 11;
  st.lastActionAt = 12;
  st.voiceProfile = 'longhua';
  st.bootstrapSent = true;
  st.roleCardInjected = true;
  st.wakeTimes = [13, 14];
  st.sendTimes = [15, 16];
  st.ttsSpeakTimes = [17, 18];
  st.stickerCollectTimes = [19];
  st.lastIncomingAt = 20;
  st.proactiveGreetingEnabled = false;
  st.proactiveTopicIndex = 4;
  st.lastMealSlot = 'dinner';
  st.preSleepWaitSatisfiedAt = 21;
  st.preSleepWaitObservedAt = 22;
  st.preSleepWaitAccumMs = 23;
  st.lastUnreadSeq = 10;
  st.lastReadThroughSeq = 5;
  st.pendingWakeReasons = [{ reason: 'question', seq: 10, at: now - 1000 }];
  st.activeTopics = [
    { text: 'topic', lastMentionAt: now },
    { text: '约好出去走走', lastMentionAt: now, dueAt: now + 3600000, status: 'open', lastNudgedAt: 0, nudgeCount: 0 }
  ];
  st.pendingThoughts = [{ text: 'thought' }];
  st.memberImpressions = {
    春树君: { traits: ['喜欢樱花'], progress: [{ at: now - 2000, note: '开始叫我良公主' }] }
  };
  st.modelSeenSeqs = new Set([1]);
  st.lastSpeaker = { userId: '7770486', isOwner: true };
  return st;
}

test('field coverage: create() keys == persisted keys + ephemeral keys', () => {
  const keys = Object.keys(createConversationState()).sort();
  const expected = [...PERSISTED_CONVERSATION_KEYS, ...EPHEMERAL_CONVERSATION_KEYS].sort();
  assert.deepEqual(keys, expected);
});

test('create() gives each conversation its own mutable containers', () => {
  const a = createConversationState();
  const b = createConversationState();
  for (const key of ['activeTopics', 'pendingThoughts', 'recentMessages', 'unread', 'wakeTimes', 'sendTimes']) {
    assert.notEqual(a[key], b[key], `${key} 不应在会话间共享引用`);
  }
  assert.notEqual(a.memberImpressions, b.memberImpressions);
  a.activeTopics.push({ text: 'private-only' });
  a.memberImpressions['某人'] = { traits: ['私聊'] };
  assert.equal(b.activeTopics.length, 0);
  assert.deepEqual(b.memberImpressions, {});
});

test('serialize() contains every persisted key plus seenForwardIds only', () => {
  const serialized = serializeConversationState(richState(), { seenForwardIds: ['f1'] });
  const keys = Object.keys(serialized).sort();
  const expected = [...PERSISTED_CONVERSATION_KEYS, ...PERSISTED_EXTRA_KEYS].sort();
  assert.deepEqual(keys, expected);
  for (const key of EPHEMERAL_CONVERSATION_KEYS) assert.equal(key in serialized, false);
});

test('round-trip preserves all persisted fields', () => {
  const source = richState();
  const serialized = serializeConversationState(source, { seenForwardIds: ['f1'] });
  const loaded = hydrateConversationState(serialized, { defaultWakeConfig: () => defaultWakeConfig });
  for (const key of PERSISTED_CONVERSATION_KEYS) {
    assert.deepEqual(loaded[key], source[key], `field ${key} changed`);
  }
  assert.equal(loaded.modelSeenSeqs.size, 0);
  assert.equal(loaded.lastSpeaker, null);
  assert.equal(loaded.pendingWakeTimer, null);
  assert.equal(loaded.sleepTimer, null);
});

test('agentToken stays unique across conversations', () => {
  const seen = new Set();
  const a = hydrateConversationState({ agentToken: 'same-token' }, { defaultWakeConfig, seenAgentTokens: seen });
  const b = hydrateConversationState({ agentToken: 'same-token' }, { defaultWakeConfig, seenAgentTokens: seen });
  assert.equal(a.agentToken, 'same-token');
  assert.notEqual(b.agentToken, 'same-token');
});

test('memberImpressions proto keys are filtered, progress preserved', () => {
  const raw = JSON.parse('{"__proto__":{"polluted":true},"春树君":{"traits":["x"],"progress":[{"at":1,"note":"p"}]}}');
  const loaded = hydrateConversationState({ memberImpressions: raw }, { defaultWakeConfig });
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.memberImpressions, '__proto__'), false);
  assert.equal(loaded.memberImpressions.春树君.progress[0].note, 'p');
  assert.equal(({}).polluted, undefined);
});

test('pendingWakeReasons malformed/old entries are normalized away', () => {
  const loaded = hydrateConversationState({
    pendingWakeReasons: [
      null,
      { reason: 123, seq: 1, at: now },
      { reason: 'question', seq: 1, at: 0 },
      { reason: 'question', seq: 2, at: now - 1000 }
    ]
  }, { defaultWakeConfig });
  assert.deepEqual(loaded.pendingWakeReasons, [{ reason: 'question', seq: 2, at: now - 1000 }]);
});

test('arrays are capped on save', () => {
  const st = createConversationState({ wakeConfig: defaultWakeConfig });
  st.recentMessages = Array.from({ length: 250 }, (_, i) => ({ seq: i }));
  st.unread = Array.from({ length: 150 }, (_, i) => ({ seq: i }));
  st.pendingWakeReasons = Array.from({ length: 25 }, (_, i) => ({ reason: 'question', seq: i + 1, at: now }));
  const serialized = serializeConversationState(st);
  assert.equal(serialized.recentMessages.length, 200);
  assert.equal(serialized.unread.length, 100);
  assert.equal(serialized.pendingWakeReasons.length, 20);
});

test('lastMealSlot survives round-trip', () => {
  const st = createConversationState({ wakeConfig: defaultWakeConfig });
  st.lastMealSlot = 'lunch';
  const loaded = hydrateConversationState(serializeConversationState(st), { defaultWakeConfig });
  assert.equal(loaded.lastMealSlot, 'lunch');
});

test('lastReadThroughSeq is clamped to lastUnreadSeq', () => {
  const loaded = hydrateConversationState({ lastUnreadSeq: 3, lastReadThroughSeq: 99 }, { defaultWakeConfig });
  assert.equal(loaded.lastReadThroughSeq, 3);
});

console.log(`\n${passed} passed`);
