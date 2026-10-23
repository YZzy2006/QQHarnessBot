// social-v2 单会话状态的唯一 schema：默认值 / save 序列化 / load 反序列化都在这里。
// 目的：不再让 default / load / save 三份手写字段列表漂移（pendingWakeReasons、
// lastMealSlot 都曾因此被写丢）。纯函数；不读写文件、不依赖 bridge 闭包。
import crypto from 'node:crypto';

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => Number(v) || 0;
const str = (v) => String(v ?? '');
const bool = (v) => !!v;

/** 只存在于内存、不落盘的字段（定时器句柄、模型已见 seq、门禁用的最近发言人）。 */
export const EPHEMERAL_CONVERSATION_KEYS = Object.freeze([
  'pendingWakeTimer',
  'sleepTimer',
  'replyCheckTimer',
  'proactiveTimer',
  'mealTimer',
  'modelSeenSeqs',
  'lastSpeaker'
]);

/**
 * 每个持久字段一个 save/load 转换器。PERSISTED_CONVERSATION_KEYS 由它派生，
 * 测试会用同一个列表做 round-trip 和字段覆盖，避免再漏字段。
 */
const SPEC = {
  wakeConfig: {
    default: null,
    save: (st) => st.wakeConfig,
    load: (val, { defaultWakeConfig }) => {
      const d = typeof defaultWakeConfig === 'function' ? defaultWakeConfig() : (defaultWakeConfig || {});
      const raw = val && typeof val === 'object' ? val : {};
      return {
        ...d,
        ...raw,
        triggers: { ...(d?.triggers || {}), ...(raw.triggers || {}) }
      };
    }
  },
  recentMessages: {
    default: [],
    save: (st) => arr(st.recentMessages).slice(-200),
    load: (val) => arr(val)
  },
  unread: {
    default: [],
    save: (st) => arr(st.unread).slice(-100),
    load: (val) => arr(val)
  },
  lastWakeReason: {
    default: '',
    save: (st) => str(st.lastWakeReason),
    load: (val) => str(val)
  },
  lastAiReplyAt: {
    default: 0,
    save: (st) => num(st.lastAiReplyAt),
    load: (val) => num(val)
  },
  lastActionAt: {
    default: 0,
    save: (st) => num(st.lastActionAt),
    load: (val) => num(val)
  },
  voiceProfile: {
    default: '',
    save: (st) => str(st.voiceProfile),
    load: (val) => str(val)
  },
  agentToken: {
    default: '',
    save: (st) => str(st.agentToken),
    load: (val, ctx) => {
      let token = str(val).trim();
      if (!token || ctx.seenAgentTokens.has(token)) token = crypto.randomBytes(16).toString('hex');
      ctx.seenAgentTokens.add(token);
      return token;
    }
  },
  bootstrapSent: {
    default: false,
    save: (st) => bool(st.bootstrapSent),
    load: (val) => bool(val)
  },
  roleCardInjected: {
    default: false,
    save: (st) => bool(st.roleCardInjected),
    load: (val) => bool(val)
  },
  roleCardVersion: {
    default: '',
    save: (st) => /^[a-f0-9]{16}$/.test(str(st.roleCardVersion)) ? st.roleCardVersion : '',
    load: (val) => /^[a-f0-9]{16}$/.test(str(val)) ? val : ''
  },
  wakeTimes: {
    default: [],
    save: (st) => arr(st.wakeTimes).slice(-200),
    load: (val) => arr(val)
  },
  sendTimes: {
    default: [],
    save: (st) => arr(st.sendTimes).slice(-500),
    load: (val) => arr(val)
  },
  ttsSpeakTimes: {
    default: [],
    save: (st) => arr(st.ttsSpeakTimes).slice(-500),
    load: (val) => arr(val).map(Number).filter(Number.isFinite)
  },
  stickerCollectTimes: {
    default: [],
    save: (st) => arr(st.stickerCollectTimes).slice(-500),
    load: (val) => arr(val)
  },
  lastIncomingAt: {
    default: 0,
    save: (st) => num(st.lastIncomingAt),
    load: (val) => num(val)
  },
  // 单会话「主动问候」开关。false 时跳过 proactiveCheck / mealTime；
  // 提醒、到点跟进（followup）不受影响。
  proactiveGreetingEnabled: {
    default: true,
    save: (st) => st.proactiveGreetingEnabled !== false,
    load: (val) => val !== false
  },
  // 主动开口的话题方向索引：每次成功投递 proactiveCheck 后 +1，避免总在同一类话题里打转。
  proactiveQuietUntil: {
    default: 0,
    save: (st) => num(st.proactiveQuietUntil),
    load: num
  },
  proactiveAvoidTopics: {
    default: [],
    save: (st) => arr(st.proactiveAvoidTopics).filter((v) => typeof v === 'string').slice(0, 10).map((v) => v.slice(0, 20)),
    load: (val) => arr(val).filter((v) => typeof v === 'string').slice(0, 10).map((v) => v.slice(0, 20))
  },
  proactiveTopicIndex: {
    default: 0,
    save: (st) => num(st.proactiveTopicIndex),
    load: (val) => num(val)
  },
  lastMealSlot: {
    default: '',
    save: (st) => str(st.lastMealSlot),
    load: (val) => str(val)
  },
  preSleepWaitSatisfiedAt: {
    default: 0,
    save: (st) => num(st.preSleepWaitSatisfiedAt),
    load: (val) => num(val)
  },
  preSleepWaitObservedAt: {
    default: 0,
    save: (st) => num(st.preSleepWaitObservedAt),
    load: (val) => num(val)
  },
  preSleepWaitAccumMs: {
    default: 0,
    save: (st) => num(st.preSleepWaitAccumMs),
    load: (val) => num(val)
  },
  lastUnreadSeq: {
    default: 0,
    save: (st) => num(st.lastUnreadSeq),
    load: (val) => num(val)
  },
  lastReadThroughSeq: {
    default: 0,
    save: (st) => num(st.lastReadThroughSeq),
    load: (val, { raw }) => (
      Number.isSafeInteger(Number(val)) && Number(val) >= 0
        ? Math.min(Number(val), num(raw?.lastUnreadSeq))
        : 0
    )
  },
  pendingWakeReasons: {
    default: [],
    save: (st) => arr(st.pendingWakeReasons).slice(-20),
    load: (val) => arr(val)
      .filter((r) => r && typeof r === 'object' && typeof r.reason === 'string')
      .map((r) => ({
        reason: String(r.reason).slice(0, 80),
        seq: Number(r.seq) || 0,
        at: Number(r.at) || 0
      }))
      .filter((r) => r.at > 0)
      .slice(-20)
  },
  activeTopics: {
    default: [],
    save: (st) => arr(st.activeTopics).slice(-50),
    load: (val) => arr(val)
  },
  pendingThoughts: {
    default: [],
    save: (st) => arr(st.pendingThoughts).slice(-50),
    load: (val) => arr(val)
  },
  memberImpressions: {
    default: {},
    save: (st) => (st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}),
    load: (val) => {
      const raw = val && typeof val === 'object' ? val : {};
      const clean = {};
      for (const [key, value] of Object.entries(raw)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        clean[key] = value;
      }
      return clean;
    }
  }
};

export const PERSISTED_CONVERSATION_KEYS = Object.freeze(Object.keys(SPEC));
export const PERSISTED_EXTRA_KEYS = Object.freeze(['seenForwardIds']);

// 默认值是模块级常量；数组/对象必须克隆后再挂到会话上，否则所有新建会话会共享
// 同一个 activeTopics / memberImpressions / unread 引用——私聊的记忆会直接出现在
// 群聊 prompt 里，而且互相 append 会串数据。hydrate 路径本来就会新建容器，这里只
// 需要修 create 路径。
function cloneDefault(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') return {};
  return value;
}

export function createConversationState({ wakeConfig = null, agentToken = '' } = {}) {
  const st = {};
  for (const [key, spec] of Object.entries(SPEC)) st[key] = cloneDefault(spec.default);
  st.wakeConfig = wakeConfig;
  st.agentToken = agentToken || crypto.randomBytes(16).toString('hex');
  st.pendingWakeTimer = null;
  st.sleepTimer = null;
  st.replyCheckTimer = null;
  st.proactiveTimer = null;
  st.mealTimer = null;
  st.modelSeenSeqs = new Set();
  st.lastSpeaker = null;
  return st;
}

export function serializeConversationState(st, { seenForwardIds = [] } = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(SPEC)) out[key] = spec.save(st || {});
  out.seenForwardIds = arr(seenForwardIds).slice(-1000);
  return out;
}

export function hydrateConversationState(val, { defaultWakeConfig, seenAgentTokens = new Set() } = {}) {
  const raw = val && typeof val === 'object' ? val : {};
  const ctx = { raw, defaultWakeConfig, seenAgentTokens };
  const st = {};
  for (const [key, spec] of Object.entries(SPEC)) st[key] = spec.load(raw[key], ctx);
  st.pendingWakeTimer = null;
  st.sleepTimer = null;
  st.replyCheckTimer = null;
  st.proactiveTimer = null;
  st.mealTimer = null;
  st.modelSeenSeqs = new Set();
  st.lastSpeaker = null;
  return st;
}
