// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as qzone from '../src/qzone.js';
import * as qzoneSocial from '../src/qzone-social.js';
import * as qzoneFeedQuery from '../src/qzone-feed-query.js';
import * as qzoneProfileLike from '../src/qzone-profile-like.js';
import * as friendRequests from '../src/friend-requests.js';
import * as friendViews from '../src/friend-views.js';
import * as ownerCommandGuide from '../src/owner-command-guide.js';
import * as ownerConsole from '../src/owner-console.js';
import * as ownerInspect from '../src/owner-inspect.js';
import * as qqFaces from '../src/qq-faces.js';
import * as whitelistCommands from '../src/whitelist-commands.js';
import * as ownerExtra from '../src/owner-extra.js';
import * as ownerActions from '../src/owner-actions.js';
import * as ownerToolsModule from '../src/owner-tools.js';
import * as companionModule from '../src/companion.js';
import * as utilitiesModule from '../src/utilities.js';
import * as privateReportModule from '../src/private-report-guard.js';
import * as utilityNewsModule from '../src/utility-news.js';
import * as lifeServicesModule from '../src/life-services.js';
import * as ownerSummaryModule from '../src/owner-summary.js';
import * as commandArgs from '../src/command-args.js';
import * as targetResolve from '../src/target-resolve.js';
import * as timeParse from '../src/time-parse.js';
import * as proactivePolicy from '../src/proactive-policy.js';
import * as proactiveTopics from '../src/proactive-topics.js';
import * as qwenVl from '../src/qwen-vl.js';
import * as groupViews from '../src/group-views.js';
import * as adminActions from '../src/admin-actions.js';
import * as groupChat from '../src/group-chat.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as voiceAsr from '../src/voice-asr.js';
import * as fileReader from '../src/file-reader.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as roleCard from '../src/role-card.js';
import * as linkPreview from '../src/link-preview.js';
import * as ttsBailian from '../src/tts-bailian.js';
import * as ttsNext from '../src/tts-next.js';
import * as snowlumaConn from '../src/snowluma-conn.js';
import * as reliability from '../src/reliability.js';
import * as followup from '../src/followup.js';
import * as socialState from '../src/social-state.js';
import * as memorySemantic from '../src/memory-semantic.js';
import * as recurrence from '../src/recurrence.js';
import * as imageGen from '../src/image-gen.js';
import * as imageQuota from '../src/image-quota.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false },
    // 测试默认关掉随机自动表情/千问兜底，避免断言随概率或外网抖动；需要测时显式覆盖。
    emoji: { enabled: false }, vision: { fallbackEnabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = {
    created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], http: [],
    qzoneSends: [], qzonePosts: [], qzoneFailSend: false, qzoneFailList: false, qzoneTimeoutAfterPost: false,
    qzoneFeeds: [], qzoneLikes: [], qzoneUnlikes: [], qzoneComments: [], qzoneCommentDeletes: [], qzoneFailFeeds: false,
    qzoneFriends: [], qzoneFriendPosts: [], profileLikes: [], friendRequestHandles: [],
    privateForwards: [], friendHistory: [], privateForwardFail: false, privateForwardFailOnce: false,
    groups: [], groupMembers: [], groupHistory: [], getMessageData: {},
    groupInfo: null, groupInfoFailIds: [], groupNotices: [], marks: [], forwardMessages: [], forwardReads: [],
    pokes: [], profileChanges: [], profileLike: { favoriteInfo: { total_count: 0, today_count: 0, userInfos: [] }, voteInfo: { total_count: 0, new_count: 0, userInfos: [] } },
    groupSystemMsgs: [], groupAddRequests: [], kicks: [], bans: [], wholeBans: [],
    groupCards: [], groupNames: [], groupAdmins: [], groupLeaves: [],
    honorReads: [], honors: {
      current_talkative: null,
      talkative_list: [],
      performer_list: [],
      legend_list: [],
      emotion_list: [],
      strong_newbie_list: []
    },
    atAllReads: [], atAllRemains: {
      can_at_all: true,
      remain_at_all_count_for_group: 19,
      remain_at_all_count_for_uin: 10
    },
    specialTitles: [], essenceSet: [], essenceDeleted: [], groupSigns: [], emojiLikes: [],
    deletedMsgs: [], friendRemarks: [], deletedFriends: [],
    doubtFriendRequests: [], doubtFriendHandles: [],
    selfUin: 2867977191
  };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    if (String(url) === 'https://api.deepseek.com/chat/completions') {
      return { ok: true, status: 200, json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: '主要话题：报告。' } }],
        usage: { prompt_tokens: 30, prompt_cache_miss_tokens: 20, prompt_cache_hit_tokens: 10, completion_tokens: 50 }
      }) };
    }
    if (String(url).includes('api.deepseek.com/user/balance')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          is_available: true,
          balance_infos: [{
            currency: 'CNY',
            total_balance: '27.45',
            granted_balance: '0.00',
            topped_up_balance: '27.45'
          }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  // 出站消息可能是 MessageChain、段数组或字符串；测试断言统一取可读文本，
  // 同时保留原始 segments 供表情/引用段断言。
  function outgoingText(message) {
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      return message.map((seg) => {
        if (!seg || typeof seg !== 'object') return '';
        if (seg.type === 'text') return String(seg.data?.text ?? '');
        if (seg.type === 'face') return `[face:${seg.data?.id ?? ''}]`;
        if (seg.type === 'at') return `@${seg.data?.qq ?? ''}`;
        if (seg.type === 'reply') return `[reply:${seg.data?.id ?? ''}]`;
        return `[${seg.type}]`;
      }).join('');
    }
    if (message && typeof message.toString === 'function') return String(message);
    return String(message ?? '');
  }

  class FakeBot {
    async sendPrivateMessage(id, message) { calls.sent.push({ kind: 'private', id, text: outgoingText(message), segments: message }); }
    async sendGroupMessage(id, message) { calls.sent.push({ kind: 'group', id, text: outgoingText(message), segments: message }); }
    // 与 SDK 一致：raw() 解包 data，失败时抛错；桥接的 [看转发] 走这条路径。
    async raw(action, params = {}) {
      const res = await this.request(action, params);
      if (res?.status !== 'ok' || Number(res?.retcode) !== 0) {
        throw new Error(`${res?.status}/${res?.retcode} ${res?.wording ?? ''}`.trim());
      }
      return res?.data;
    }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async getLoginInfo() {
      return { user_id: calls.selfUin, nickname: 'fixture-bot' };
    }
    async request(action, params = {}) {
      if(action==='send_private_msg'||action==='send_group_msg') {
        if (calls.locationSendFailure && params.message?.some(s => s.type === 'json' && String(s.data?.data).includes('com.tencent.map'))) throw new Error('fixture location card rejected');
        if(action==='send_private_msg') await this.sendPrivateMessage(params.user_id,params.message);
        else await this.sendGroupMessage(params.group_id,params.message);
        return {status:'ok',retcode:0,data:{message_id:990000+calls.sent.length}};
      }
      if (action === 'send_qzone_msg') {
        calls.qzoneSends.push(params);
        const item = { tid: `fixture-qzone-${calls.qzonePosts.length + 1}`, content: params.content, time: Math.floor(Date.now() / 1000), is_private: params.ugc_right === 64 };
        if (calls.qzoneTimeoutAfterPost) {
          calls.qzonePosts.push(item);
          throw new Error('fixture qzone send timeout after post');
        }
        if (calls.qzoneFailSend) throw new Error('fixture qzone send timeout');
        calls.qzonePosts.push(item);
        return { status: 'ok', retcode: 0, data: { tid: item.tid, time: item.time } };
      }
      if (action === 'get_qzone_msg_list') {
        if (calls.qzoneFailList) throw new Error('fixture qzone list timeout');
        const posts = calls.qzoneFriendPosts.length
          ? calls.qzoneFriendPosts
          : [...calls.qzonePosts].reverse();
        return { status: 'ok', retcode: 0, data: { total: posts.length, msglist: posts } };
      }
      if (action === 'get_friend_list') {
        return { status: 'ok', retcode: 0, data: calls.qzoneFriends };
      }
      if (action === 'delete_qzone_msg') {
        const idx = calls.qzonePosts.findIndex((item) => item.tid === params.tid);
        if (idx >= 0) calls.qzonePosts.splice(idx, 1);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_qzone_msg_right') {
        const item = calls.qzonePosts.find((entry) => entry.tid === params.tid);
        if (item) item.ugc_right = params.ugc_right;
        return { status: 'ok', retcode: 0, data: { ugc_right: params.ugc_right } };
      }
      if (action === 'get_qzone_feeds') {
        if (calls.qzoneFailFeeds) throw new Error('fixture qzone feeds timeout');
        return { status: 'ok', retcode: 0, data: { feeds: [...calls.qzoneFeeds], has_more: false } };
      }
      if (action === 'like_qzone') {
        calls.qzoneLikes.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'unlike_qzone') {
        calls.qzoneUnlikes.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'send_like') {
        calls.profileLikes.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'get_stranger_info') {
        return { status: 'ok', retcode: 0, data: { user_id: params.user_id, nickname: `stranger-${params.user_id}` } };
      }
      if (action === 'set_friend_add_request') {
        calls.friendRequestHandles.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'get_friend_msg_history') {
        return { status: 'ok', retcode: 0, data: { messages: calls.friendHistory } };
      }
      if (action === 'get_profile_like') {
        return { status: 'ok', retcode: 0, data: calls.profileLike };
      }
      if (action === 'send_poke') {
        calls.pokes.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_qq_profile') {
        calls.profileChanges.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'get_group_list') {
        return { status: 'ok', retcode: 0, data: calls.groups };
      }
      if (action === 'get_group_info') {
        if ((calls.groupInfoFailIds || []).map(Number).includes(Number(params.group_id))) {
          return { status: 'failed', retcode: 100, wording: 'not a group' };
        }
        return {
          status: 'ok',
          retcode: 0,
          data: calls.groupInfo ?? {
            group_id: params.group_id,
            group_name: 'fixture-group',
            member_count: 4,
            max_member_count: 200,
            owner_id: 123,
            create_time: 1577900000,
            group_all_shut: 0
          }
        };
      }
      if (action === '_get_group_notice') {
        return { status: 'ok', retcode: 0, data: calls.groupNotices };
      }
      if (action === 'mark_private_msg_as_read' || action === 'mark_group_msg_as_read') {
        calls.marks.push({ action, ...params });
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'get_forward_msg') {
        calls.forwardReads.push(params);
        return { status: 'ok', retcode: 0, data: { messages: calls.forwardMessages } };
      }
      if (action === 'get_group_member_list') {
        return { status: 'ok', retcode: 0, data: calls.groupMembers };
      }
      if (action === 'get_group_msg_history') {
        return { status: 'ok', retcode: 0, data: { messages: calls.groupHistory } };
      }
      if (action === 'get_msg') {
        const data = calls.getMessageData[String(params.message_id)] || null;
        return data
          ? { status: 'ok', retcode: 0, data }
          : { status: 'failed', retcode: 100, wording: 'not found' };
      }
      if (action === 'get_group_system_msg') {
        return { status: 'ok', retcode: 0, data: calls.groupSystemMsgs };
      }
      if (action === 'get_doubt_friends_add_request') {
        return { status: 'ok', retcode: 0, data: calls.doubtFriendRequests };
      }
      if (action === 'set_doubt_friends_add_request') {
        calls.doubtFriendHandles.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_add_request') {
        calls.groupAddRequests.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_kick') {
        calls.kicks.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_ban') {
        calls.bans.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_whole_ban') {
        calls.wholeBans.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_card') {
        calls.groupCards.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_name') {
        calls.groupNames.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_admin') {
        calls.groupAdmins.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'get_group_honor_info') {
        calls.honorReads.push(params);
        return { status: 'ok', retcode: 0, data: calls.honors };
      }
      if (action === 'get_group_at_all_remain') {
        calls.atAllReads.push(params);
        return { status: 'ok', retcode: 0, data: calls.atAllRemains };
      }
      if (action === 'set_group_special_title') {
        calls.specialTitles.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_essence_msg') {
        calls.essenceSet.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'delete_essence_msg') {
        calls.essenceDeleted.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_sign') {
        calls.groupSigns.push(params);
        return { status: 'ok', retcode: 0, data: {} };
      }
      if (action === 'set_msg_emoji_like') {
        calls.emojiLikes.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_group_leave') {
        calls.groupLeaves.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'delete_msg') {
        calls.deletedMsgs.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'set_friend_remark') {
        calls.friendRemarks.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'delete_friend') {
        calls.deletedFriends.push(params);
        return { status: 'ok', retcode: 0, data: null };
      }
      if (action === 'send_private_forward_msg') {
        calls.privateForwards.push(params);
        if (calls.privateForwardFail) return { status: 'failed', retcode: 100, wording: 'fixture forward fail' };
        if (calls.privateForwardFailOnce) {
          calls.privateForwardFailOnce = false;
          return { status: 'failed', retcode: 100, wording: 'fixture forward fail once' };
        }
        return { status: 'ok', retcode: 0, data: { message_id: 9002, res_id: 'fixture-forward', forward_id: 'fixture-forward' } };
      }
      if (action === 'comment_qzone') {
        calls.qzoneComments.push(params);
        return { status: 'ok', retcode: 0, data: { comment_id: `fixture-comment-${calls.qzoneComments.length}` } };
      }
      if (action === 'delete_qzone_comment') {
        calls.qzoneCommentDeletes.push(params);
        return { status: 'ok', retcode: 0, data: { ok: true } };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    recordSessionSnapshot, rebuildInFlightCollector, isConversationBusyV2, drainPendingWakesV2: typeof drainPendingWakesV2 === 'function' ? drainPendingWakesV2 : undefined,
    collectors, collectorStartedAt, turnLastActivityAt, v2TurnStartAt, pendingWakeKeys,
    formatParticipationV2, evaluateWakeTriggerV2, defaultWakeConfigV2,
    resetWakeConfigV2, groupSoftWakeAllowedV2,
    getQzoneState: () => qzoneState,
    getQzoneSocialState: () => qzoneSocialState,
    getFriendRequestState: () => friendRequestState,
    getReminders: () => reminders, companion, lifeServices, sendCompanionMessage, sendCompanionLocation, utilities, privateReportGuard, sendUtilityMessage, resolveReplyInfo, appendMemoryV2,
    ownerTools, loadReminders, saveReminders, fireDueReminders, saveSocialV2State, resolveAnyTarget,
    handleFriendRequestEvent,
    handleFriendAddedEvent,
    syncFriendSnapshot,
    resetQzoneFriendCache() { qzoneFriendCache = { at: 0, list: [] }; },
    resetProfileLikeCandidates() { profileLikeCandidates = { at: 0, items: [] }; },
    runQzoneSocialCheck,
    deleteQzoneSocialComment,
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, uptime: () => 123.4, env: { DEEPSEEK_API_KEY: 'fixture-deepseek-key' }, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker, ...qzone, ...groupChat, ...qzoneSocial, ...qzoneFeedQuery, ...qzoneProfileLike, ...friendRequests, ...friendViews, ...ownerCommandGuide, ...ownerConsole, ...ownerInspect, ...qqFaces, ...whitelistCommands, ...ownerExtra, ...ownerActions, ...ownerToolsModule, ...ownerSummaryModule, ...commandArgs, ...targetResolve, ...timeParse, ...proactivePolicy, ...proactiveTopics, ...qwenVl, ...groupViews, ...adminActions,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl,
    ...voiceAsr, ...fileReader, ...presetPrompt, ...roleCard, ...linkPreview,
    ...ttsBailian, ...ttsNext, ...snowlumaConn, ...reliability, ...followup, ...socialState,
    ...memorySemantic, ...recurrence, ...imageGen, ...imageQuota, ...companionModule, ...lifeServicesModule, ...utilitiesModule, ...privateReportModule, ...utilityNewsModule,
    // bridge.js 对这些导出做了重命名导入；VM 注入的是原始导出名，这里补别名。
    setMemoryVectorLogger: memorySemantic.setLogger,
    warmMemoryVectors: memorySemantic.warmUp,
    indexMemoryVector: memorySemantic.indexMemory,
    removeMemoryVectorRefs: memorySemantic.removeMemoryRefs,
    flushMemoryVectors: memorySemantic.flushVectors,
    recallMemoryVectors: memorySemantic.recallMemory,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
