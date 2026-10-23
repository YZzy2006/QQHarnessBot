#!/usr/bin/env node
// 好友空间动态互动：桥接集成测试。用 VM harness 启动真实 bridge.js，不碰真 QQ/DSH/网络。
import assert from 'node:assert/strict';
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

const OWNER = 123;
const SELF_UIN = 2867977191;
const HOUR = 3600 * 1000;
const nowSec = () => Math.floor(Date.now() / 1000);
const TID = (n) => n.toString(16).padStart(24, '0');

const bridge = await bridgeHarness({
  config: {
    socialV2: {
      qzone: { enabled: true },
      qzoneSocial: {
        enabled: true,
        likeEnabled: true,
        commentEnabled: true,
        checkTimes: ['10:00', '22:00'],
        checkMinMs: 20 * 60 * 1000,
        checkMaxMs: 40 * 60 * 1000,
        feedFetchCount: 10,
        feedScanLimit: 10,
        feedMaxAgeHours: 48,
        // 测试里保留一个“过期”样本，显式用严格窗口；生产默认是 72h/48h。
        likeWindowHours: 24,
        commentWindowHours: 12,
        activeStartHour: 0,
        activeEndHour: 0, // start===end -> 全天
        likeProbability: 1,
        commentProbability: 1,
        maxLikesPerDay: 10,
        maxCommentsPerDay: 10,
        maxLikesPerFriendPerDay: 1,
        maxCommentsPerFriendPerDay: 1,
        maxActionsPerCheck: 5,
        maxCommentsPerCheck: 1,
        actionGapMs: 0,
        likeMinIntervalMs: 0,
        commentMinIntervalMs: 0,
        followUpEnabled: true,
        followUpMinIntervalMs: 0,
        maxFollowUpsPerDay: 2,
        maxFollowUpsPerPost: 2,
        maxFollowUpsPerCheck: 1
      }
    }
  }
});

const calls = bridge.calls;

function feed(overrides = {}) {
  return {
    uin: 111,
    nickname: '示例好友甲',
    time: nowSec() - 3600,
    appid: 311,
    key: TID(1),
    html: '<div class="f-info">示例好友甲 10月19日 19:00 晚饭吃了个很怪的搭配 <a>浏览12次</a></div>',
    ...overrides
  };
}

function feedWithComments({
  botComment = '看着就香',
  replyNick = '示例好友甲',
  replyText = '是吧，下次一起',
  replyUin = 111
} = {}) {
  return feed({
    html: `<div class="f-info">示例好友甲 10月19日 19:00 晚饭吃了个很怪的搭配 <a>浏览12次</a></div>
      <div class="mod-comments"><div class="comments-list"><ul>
      <li class="comments-item bor3" data-type="commentroot" data-tid="1" data-uin="${SELF_UIN}" data-nick="樱良"><div class="comments-content"><a href="http://user.qzone.qq.com/${SELF_UIN}">樱良</a>&nbsp; : ${botComment} <div class="comments-op"><span class="state">10月19日 10:00</span></div></div></li>
      <li class="comments-item bor3" data-type="replyroot" data-tid="1" data-uin="${replyUin}" data-nick="${replyNick}"><div class="comments-content"><a href="http://user.qzone.qq.com/${replyUin}">${replyNick}</a>&nbsp;回复<a href="http://user.qzone.qq.com/${SELF_UIN}">樱良</a>&nbsp; : ${replyText} <div class="comments-op"><span class="state">10月19日 21:00</span></div></div></li>
      </ul></div></div>`
  });
}

function seedCommented(item, overrides = {}) {
  bridge.getQzoneSocialState().seen[item.key] = {
    uin: item.uin,
    nickname: item.nickname,
    time: item.time,
    text: '晚饭吃了个很怪的搭配',
    likedAt: 0,
    commentedAt: Date.now() - 2 * 3600 * 1000,
    comment: '看着就香',
    handledReplies: [],
    followUpCount: 0,
    lastFollowUpAt: 0,
    error: '',
    ...overrides
  };
}

function seedPending(item, overrides = {}) {
  bridge.getQzoneSocialState().pendingComment = {
    id: 'c_test01',
    kind: 'comment',
    tid: item.key,
    uin: item.uin,
    nickname: item.nickname,
    text: '晚饭吃了个很怪的搭配',
    comment: '看着就香',
    ourComment: '',
    replyNick: '',
    replyText: '',
    handledSigs: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    ...overrides
  };
}

function seedSeen(item, overrides = {}) {
  bridge.getQzoneSocialState().seen[item.key] = {
    uin: item.uin,
    nickname: item.nickname,
    time: item.time,
    text: '晚饭吃了个很怪的搭配',
    likedAt: 0,
    commentedAt: 0,
    comment: '',
    commentId: '',
    commentDeletedAt: 0,
    commentProposedAt: 0,
    commentCancelledAt: 0,
    handledReplies: [],
    followUpCount: 0,
    lastFollowUpAt: 0,
    error: '',
    ...overrides
  };
}

function resetFriendRequests() {
  const st = bridge.getFriendRequestState();
  st.requests = [];
  st.friends = {};
  st.snapshot = { at: 0, uins: [] };
  calls.friendRequestHandles.length = 0;
}

function resetSocial() {
  const st = bridge.getQzoneSocialState();
  st.enabled = true;
  st.likeEnabled = true;
  st.commentEnabled = true;
  st.requireCommentApproval = false;
  st.pendingComment = null;
  st.lastQuery = null;
  st.selfUin = SELF_UIN;
  st.seen = {};
  st.recentComments = [];
  st.daily = {};
  st.perFriend = {};
  st.lastLikeAt = 0;
  st.lastCommentAt = 0;
  st.lastCheckAt = 0;
  st.nextCheckAt = 0;
  st.lastError = '';
  calls.qzoneFeeds.length = 0;
  calls.qzoneLikes.length = 0;
  calls.qzoneUnlikes.length = 0;
  calls.qzoneComments.length = 0;
  calls.qzoneCommentDeletes.length = 0;
  calls.qzoneFriends.length = 0;
  calls.qzoneFriendPosts.length = 0;
  calls.profileLikes.length = 0;
  calls.privateForwards.length = 0;
  calls.friendHistory.length = 0;
  calls.privateForwardFail = false;
  calls.privateForwardFailOnce = false;
  calls.groups.length = 0;
  calls.groupMembers.length = 0;
  calls.groupHistory.length = 0;
  for (const k of Object.keys(calls.getMessageData)) delete calls.getMessageData[k];
  for (const k of ['groupSystemMsgs', 'groupAddRequests', 'kicks', 'bans', 'wholeBans',
    'groupCards', 'groupNames', 'groupAdmins', 'groupLeaves', 'deletedMsgs',
    'friendRemarks', 'deletedFriends', 'doubtFriendRequests', 'doubtFriendHandles']) {
    calls[k].length = 0;
  }
  bridge.getReminders().clear();
  bridge.resetQzoneFriendCache();
  bridge.resetProfileLikeCandidates();
  calls.qzoneFailFeeds = false;
  calls.sent.length = 0;
}

async function run(options = {}) {
  bridge.setMode('reserved2');
  return bridge.runQzoneSocialCheck({ manual: true, ...options });
}

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

await test('dry-run 只列候选：不点赞/不评论/不通知', async () => {
  resetSocial();
  calls.qzoneFeeds.push(
    feed(),
    feed({ key: TID(2), appid: 6600, uin: 0, nickname: '' }), // 广告
    feed({ key: TID(3), uin: SELF_UIN }),                     // 自己
    feed({ key: TID(4), time: nowSec() - 30 * 3600 })          // 过期
  );
  const result = await run({ dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(calls.qzoneLikes.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.ok(result.skipped.some((item) => item.reason === 'not-mood'));
  assert.ok(result.skipped.some((item) => item.reason === 'self'));
  assert.ok(result.skipped.some((item) => item.reason === 'stale'));
});

await test('点赞：参数正确、状态落盘、私聊通知 owner', async () => {
  resetSocial();
  bridge.getQzoneSocialState().commentEnabled = false;
  const item = feed();
  calls.qzoneFeeds.push(item);
  const result = await run();
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 1);
  assert.equal(calls.qzoneLikes.length, 1);
  assert.equal(calls.qzoneLikes[0].tid, item.key);
  assert.equal(calls.qzoneLikes[0].target_uin, item.uin);
  assert.equal(calls.qzoneLikes[0].abstime, item.time);
  assert.ok(bridge.getQzoneSocialState().seen[item.key].likedAt > 0);
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /空间互动/);
  assert.match(calls.sent[0].text, /赞了/);
});

await test('同一 tid 第二轮不重复点赞', async () => {
  resetSocial();
  bridge.getQzoneSocialState().commentEnabled = false;
  const item = feed();
  calls.qzoneFeeds.push(item);
  await run();
  assert.equal(calls.qzoneLikes.length, 1);
  calls.qzoneLikes.length = 0;
  calls.sent.length = 0;
  const second = await run();
  assert.equal(second.actions.length, 0);
  assert.equal(calls.qzoneLikes.length, 0);
});

await test('同一好友同一天第二条不点赞', async () => {
  resetSocial();
  bridge.getQzoneSocialState().commentEnabled = false;
  calls.qzoneFeeds.push(
    feed({ key: TID(1), time: nowSec() - 1 * 3600 }),
    feed({ key: TID(2), time: nowSec() - 2 * 3600 })
  );
  const result = await run();
  assert.equal(result.actions.length, 1);
  assert.equal(calls.qzoneLikes.length, 1);
  assert.equal(calls.qzoneLikes[0].tid, TID(1));
});

await test('评论：注入生成器，参数正确、通知含评论和 tid', async () => {
  resetSocial();
  bridge.getQzoneSocialState().likeEnabled = false;
  const item = feed();
  calls.qzoneFeeds.push(item);
  let seenArgs = null;
  const result = await run({
    commentGenerator: async (args) => {
      seenArgs = args;
      return { ok: true, skip: false, comment: '看着就香' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 1);
  assert.equal(seenArgs.nickname, item.nickname);
  assert.equal(seenArgs.text, '晚饭吃了个很怪的搭配');
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].tid, item.key);
  assert.equal(calls.qzoneComments[0].content, '看着就香');
  assert.equal(calls.qzoneComments[0].target_uin, item.uin);
  assert.ok(bridge.getQzoneSocialState().seen[item.key].commentedAt > 0);
  assert.match(calls.sent[0].text, /评了/);
  assert.match(calls.sent[0].text, /看着就香/);
});

await test('评论确认：先生成提案私聊 owner，不直接发', async () => {
  resetSocial();
  const st = bridge.getQzoneSocialState();
  st.requireCommentApproval = true;
  st.likeEnabled = false;
  const item = feed();
  calls.qzoneFeeds.push(item);
  const result = await run({
    commentGenerator: async () => ({ ok: true, skip: false, comment: '看着就香' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.proposals, 1);
  assert.equal(result.actions.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(st.pendingComment.kind, 'comment');
  assert.equal(st.pendingComment.comment, '看着就香');
  assert.match(calls.sent[0].text, /\[评论确认\]/);
});

await test('评论确认：[评论确认] 发送并记账', async () => {
  resetSocial();
  const st = bridge.getQzoneSocialState();
  st.requireCommentApproval = true;
  const item = feed();
  seedPending(item);
  const reply = await cmd('[评论确认]');
  assert.match(reply, /已发送评论/);
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].content, '看着就香');
  assert.equal(calls.qzoneComments[0].target_uin, item.uin);
  assert.equal(st.pendingComment, null);
  assert.ok(st.seen[item.key].commentedAt > 0);
  assert.equal(st.seen[item.key].commentId, 'fixture-comment-1');
  assert.equal(st.daily[Object.keys(st.daily)[0]].comments, 1);
});

await test('评论确认：[评论修改] 更新提案，确认后再发', async () => {
  resetSocial();
  const st = bridge.getQzoneSocialState();
  st.requireCommentApproval = true;
  const item = feed();
  seedPending(item);
  const modified = await cmd('[评论修改] 换个说法');
  assert.match(modified, /已改为/);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(st.pendingComment.comment, '换个说法');
  const confirmed = await cmd('[评论确认]');
  assert.match(confirmed, /已发送评论/);
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].content, '换个说法');
});

await test('评论确认：[评论取消] 清除提案并标记不再评', async () => {
  resetSocial();
  const st = bridge.getQzoneSocialState();
  st.requireCommentApproval = true;
  const item = feed();
  seedPending(item);
  seedSeen(item, { commentProposedAt: Date.now() });
  const reply = await cmd('[评论取消]');
  assert.match(reply, /已取消/);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(st.pendingComment, null);
  assert.ok(st.seen[item.key].commentCancelledAt > 0);
  calls.qzoneFeeds.push(item);
  const again = await run({
    commentGenerator: async () => ({ ok: true, skip: false, comment: '看着就香' })
  });
  assert.equal(again.proposals, 0);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('待处理评论：[查看待处理评论] 列出待确认提案', async () => {
  resetSocial();
  const item = feed();
  seedPending(item);
  const reply = await cmd('[查看待处理评论]');
  assert.match(reply, /【待处理评论】1 条/);
  assert.match(reply, /c_test01（待确认）/);
  assert.match(reply, /看着就香/);
  assert.match(reply, /\[待评论确认 c_test01\]/);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('待处理评论：[待评论确认 <id>] 按 id 发送', async () => {
  resetSocial();
  const item = feed();
  seedPending(item);
  const reply = await cmd('[待评论确认 c_test01]');
  assert.match(reply, /已发送评论/);
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].content, '看着就香');
});

await test('待处理评论：id 不存在时不误发', async () => {
  resetSocial();
  const item = feed();
  seedPending(item);
  const reply = await cmd('[待评论确认 c_nope99]');
  assert.match(reply, /没有 id 为/);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('待处理评论：列出并重试发送失败的评论', async () => {
  resetSocial();
  const item = feed({ key: TID(7) });
  const fid = `fc_${item.key.slice(0, 8)}`;
  seedSeen(item, {
    commentedAt: Date.now() - 5000,
    comment: '旧评论',
    commentId: '',
    error: 'comment: fixture timeout'
  });
  const list = await cmd('[查看待处理评论]');
  assert.match(list, new RegExp(`【待处理评论】1 条`));
  assert.match(list, new RegExp(`${fid}（发送失败/结果未知）`));
  assert.match(list, /旧评论/);
  assert.match(list, /重试（可能重复）/);
  const retried = await cmd(`[待评论确认 ${fid}]`);
  assert.match(retried, /已重试发送评论/);
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].content, '旧评论');
});

await test('待处理评论：放弃失败评论后不再出现', async () => {
  resetSocial();
  const item = feed({ key: TID(8) });
  const fid = `fc_${item.key.slice(0, 8)}`;
  seedSeen(item, {
    commentedAt: Date.now() - 5000,
    comment: '旧评论',
    commentId: '',
    error: 'comment: fixture timeout'
  });
  const dismissed = await cmd(`[待评论取消 ${fid}]`);
  assert.match(dismissed, /已放弃/);
  const list = await cmd('[查看待处理评论]');
  assert.match(list, /当前没有待处理评论/);
});

await test('待处理评论：追评失败无正文时只能放弃', async () => {
  resetSocial();
  const item = feed({ key: TID(9) });
  const fid = `fu_${item.key.slice(0, 8)}`;
  seedSeen(item, {
    lastFollowUpAt: Date.now() - 5000,
    followUpCount: 1,
    error: 'followup: fixture timeout'
  });
  const list = await cmd('[查看待处理评论]');
  assert.match(list, new RegExp(`${fid}（追评发送失败/结果未知）`));
  assert.match(list, /正文未保存/);
  const reply = await cmd(`[待评论确认 ${fid}]`);
  assert.match(reply, /没有保存正文/);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('追评确认：先生成提案，[评论确认] 后发送', async () => {
  resetSocial();
  const st = bridge.getQzoneSocialState();
  st.requireCommentApproval = true;
  st.likeEnabled = false;
  const item = feedWithComments();
  calls.qzoneFeeds.push(item);
  seedCommented(item, { commentId: '3' });
  const result = await run({
    commentGenerator: async () => ({ ok: true, skip: false, comment: '那下次带上我' })
  });
  assert.equal(result.proposals, 1);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(st.pendingComment.kind, 'followup');
  const reply = await cmd('[评论确认]');
  assert.match(reply, /已发送追评/);
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].content, '那下次带上我');
  assert.equal(st.pendingComment, null);
  assert.equal(st.seen[item.key].followUpCount, 1);
  assert.equal(st.seen[item.key].handledReplies.length, 1);
});

await test('强制指定 tid：绕过窗口做一次点赞+评论', async () => {
  resetSocial();
  const item = feedWithComments();
  item.time = nowSec() - 30 * 24 * 3600;
  calls.qzoneFeeds.push(item);
  const result = await run({
    forceTid: item.key,
    commentGenerator: async () => ({ ok: true, skip: false, comment: '这个搭配我也想试' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.scan.forced, item.key);
  assert.equal(calls.qzoneLikes.length, 1);
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions.some((a) => a.kind === 'like'));
  assert.ok(result.actions.some((a) => a.kind === 'comment'));
});

await test('预览评论：dry-run + previewComment 只生成不发送', async () => {
  resetSocial();
  const item = feedWithComments();
  item.time = nowSec() - 30 * 24 * 3600;
  calls.qzoneFeeds.push(item);
  const result = await run({
    forceTid: item.key,
    dryRun: true,
    previewComment: true,
    commentGenerator: async () => ({ ok: true, skip: false, comment: '看着有点上头' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.preview.comment, '看着有点上头');
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(calls.qzoneLikes.length, 0);
  assert.equal(bridge.getQzoneSocialState().seen[item.key], undefined);
});

await test('追评：有人回复机器人的评论时再评一次', async () => {
  resetSocial();
  const item = feedWithComments();
  calls.qzoneFeeds.push(item);
  bridge.getQzoneSocialState().likeEnabled = false;
  seedCommented(item);
  let args = null;
  const result = await run({
    commentGenerator: async (a) => {
      args = a;
      return { ok: true, skip: false, comment: '那说定了' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(args.mode, 'followup');
  assert.equal(args.replyNick, '示例好友甲');
  assert.equal(args.replyText, '是吧，下次一起');
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].tid, item.key);
  assert.equal(calls.qzoneComments[0].content, '那说定了');
  assert.equal(bridge.getQzoneSocialState().seen[item.key].followUpCount, 1);
  assert.equal(bridge.getQzoneSocialState().seen[item.key].handledReplies.length, 1);
  assert.equal(Object.values(bridge.getQzoneSocialState().daily)[0].followUps, 1);
  assert.match(calls.sent[0].text, /追评/);
});

await test('追评：帖子超出扫描窗口但在追评窗口内仍能追评', async () => {
  resetSocial();
  const item = feedWithComments();
  item.time = nowSec() - 10 * 24 * 3600;
  calls.qzoneFeeds.push(item);
  bridge.getQzoneSocialState().likeEnabled = false;
  seedCommented(item, { time: item.time });
  const result = await run({
    commentGenerator: async () => ({ ok: true, skip: false, comment: '隔了几天才看到' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, 'followup');
  assert.equal(calls.qzoneComments.length, 1);
});

await test('追评：同一回复不会重复追评', async () => {
  resetSocial();
  const item = feedWithComments();
  calls.qzoneFeeds.push(item);
  bridge.getQzoneSocialState().likeEnabled = false;
  seedCommented(item, { handledReplies: [`111:10月19日 21:00:是吧，下次一起`] });
  const result = await run({
    commentGenerator: async () => { throw new Error('不该再叫模型'); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('追评：AI 返回 skip 时标记已处理、不发送', async () => {
  resetSocial();
  const item = feedWithComments();
  calls.qzoneFeeds.push(item);
  bridge.getQzoneSocialState().likeEnabled = false;
  seedCommented(item);
  const result = await run({
    commentGenerator: async () => ({ ok: true, skip: true, reason: '不想接' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(bridge.getQzoneSocialState().seen[item.key].handledReplies.length, 1);
});

await test('AI 返回 skip：不评论、不报错、无动作', async () => {
  resetSocial();
  bridge.getQzoneSocialState().likeEnabled = false;
  calls.qzoneFeeds.push(feed());
  const result = await run({
    commentGenerator: async () => ({ ok: true, skip: true, reason: '纯图' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(calls.sent.length, 0);
});

await test('AI 返回超长评论：不发送，记 error', async () => {
  resetSocial();
  bridge.getQzoneSocialState().likeEnabled = false;
  const item = feed();
  calls.qzoneFeeds.push(item);
  const result = await run({
    commentGenerator: async () => ({ ok: true, skip: false, comment: '一'.repeat(31) })
  });
  assert.equal(result.ok, true);
  assert.equal(calls.qzoneComments.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(bridge.getQzoneSocialState().seen[item.key].error, /comment-invalid/);
  assert.equal(calls.sent.length, 0);
});

await test('拉取好友动态失败：lastError 写入、无动作', async () => {
  resetSocial();
  calls.qzoneFailFeeds = true;
  calls.qzoneFeeds.push(feed());
  const result = await run();
  assert.equal(result.ok, false);
  assert.match(bridge.getQzoneSocialState().lastError, /feeds|timeout/i);
  assert.equal(calls.qzoneLikes.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('总开关关闭：不调 bot.request', async () => {
  resetSocial();
  bridge.getQzoneSocialState().enabled = false;
  calls.qzoneFeeds.push(feed());
  const result = await run();
  assert.equal(result.skipped, 'disabled');
  assert.equal(calls.qzoneLikes.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('qzone 总开关关闭：social 跳过（/qzone off 生效）', async () => {
  resetSocial();
  bridge.getQzoneState().enabled = false;
  calls.qzoneFeeds.push(feed());
  const result = await run();
  assert.equal(result.skipped, 'qzone-disabled');
  assert.equal(calls.qzoneLikes.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
  bridge.getQzoneState().enabled = true;
});

await test('只有广告/自己/过期：无动作', async () => {
  resetSocial();
  calls.qzoneFeeds.push(
    feed({ key: TID(1), appid: 6600, uin: 0, nickname: '' }),
    feed({ key: TID(2), uin: SELF_UIN }),
    feed({ key: TID(3), time: nowSec() - 30 * 3600 })
  );
  const result = await run();
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 0);
  assert.equal(calls.qzoneLikes.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('总指令：[指令] 发目录，按序号取详细内容，且不进上下文', async () => {
  resetSocial();
  const key = `private:${OWNER}`;
  const before = bridge.getSocialV2State(key)?.recentMessages?.length || 0;
  for (const text of ['[指令]', '[帮助]', '[命令]', '帮助', '功能']) {
    const reply = await cmd(text);
    assert.match(reply, /指令总览/);
    assert.match(reply, /好友动态查询/);
    assert.match(reply, /\[指令 序号\]/);
    assert.equal(calls.qzoneFeeds.length, 0);
  }

  const sec1 = await cmd('[指令 1]');
  assert.match(sec1, /【指令 1\//);
  assert.match(sec1, /\[查看好友动态\] \[最近3天\] \[最多5条\]/);
  assert.match(sec1, /\[查看<好友名>的动态\]/);

  const sec2 = await cmd('[指令 2]');
  assert.match(sec2, /\/qzone social/);
  assert.match(sec2, /\[评论确认\]/);

  const sec9 = await cmd('[指令 9]');
  assert.match(sec9, /\/reset-ctx/);

  const after = bridge.getSocialV2State(key)?.recentMessages?.length || 0;
  assert.equal(after, before);
});

await test('好友动态查询帮助：[好友动态查询] 返回用法规范', async () => {
  resetSocial();
  const reply = await cmd('[好友动态查询]');
  assert.match(reply, /好友动态查询 · 用法/);
  assert.match(reply, /\[查看好友动态\] \[最近30天\] \[最多5条\]/);
  assert.match(reply, /\[查看示例好友甲的动态\] \[最近30天\] \[最多10条\]/);
  assert.match(reply, /\[点赞 1\]/);
  assert.equal(calls.qzoneFeeds.length, 0);
  assert.equal(bridge.getQzoneSocialState().lastQuery, null);
});

await test('好友动态查询：全部好友 + 时间/条数过滤', async () => {
  resetSocial();
  calls.qzoneFeeds.push(
    feed({ key: TID(1), nickname: 'A', time: nowSec() - 1 * 3600 }),
    feed({ key: TID(2), nickname: 'B', time: nowSec() - 2 * 3600 }),
    feed({ key: TID(3), nickname: 'C', time: nowSec() - 30 * 3600 })
  );
  const reply = await cmd('查看好友动态 最近3天 最多2条');
  assert.match(reply, /好友动态查询/);
  assert.match(reply, /实际：2 条/);
  assert.match(reply, /\[点赞 1\]/);
  const st = bridge.getQzoneSocialState();
  assert.equal(st.lastQuery.items.length, 2);
  assert.equal(st.lastQuery.items[0].tid, TID(1));
});

await test('好友动态查询：指定好友', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 111, nickname: '示例好友甲', remark: '' });
  calls.qzoneFriendPosts.push({
    tid: TID(1),
    time: nowSec() - 3600,
    content: '示例好友乙闪卡',
    comment_num: 2,
    is_private: false
  });
  const reply = await cmd('查看示例好友甲的动态 最近3天 最多5条');
  assert.match(reply, /示例好友甲/);
  assert.match(reply, /示例好友乙闪卡/);
  assert.equal(bridge.getQzoneSocialState().lastQuery.items[0].uin, 111);
});

await test('好友动态查询：找不到好友', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 111, nickname: '示例好友甲', remark: '' });
  const reply = await cmd('查看不存在的人的动态 最近3天 最多5条');
  assert.match(reply, /没找到好友/);
});

await test('好友动态查询：[点赞 N] 对被查询的说说点赞', async () => {
  resetSocial();
  calls.qzoneFeeds.push(feed({ key: TID(1), time: nowSec() - 3600 }));
  await cmd('查看好友动态 最近3天 最多5条');
  const reply = await cmd('[点赞 1]');
  assert.match(reply, /已点赞第 1 条/);
  assert.equal(calls.qzoneLikes.length, 1);
  assert.equal(calls.qzoneLikes[0].tid, TID(1));
  assert.equal(calls.qzoneLikes[0].target_uin, 111);
});

await test('好友动态查询：[点赞 N] 重复点赞会提示已赞过，不谎报新赞', async () => {
  resetSocial();
  calls.qzoneFeeds.push(feed({ key: TID(1), time: nowSec() - 3600 }));
  await cmd('查看好友动态 最近3天 最多5条');
  await cmd('[点赞 1]');
  const reply = await cmd('[点赞 1]');
  assert.match(reply, /已经赞过了/);
  assert.match(reply, /不会重复通知/);
  assert.equal(calls.qzoneLikes.length, 2);
});

await test('资料卡点赞：唯一好友按指定次数发送', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 111, nickname: '示例好友甲', remark: '' });
  const reply = await cmd('[资料卡点赞] [示例好友甲] [3]');
  assert.match(reply, /已给「示例好友甲」（QQ 111）资料卡点赞 3 次/);
  assert.equal(calls.profileLikes[0].user_id, 111);
  assert.equal(calls.profileLikes[0].times, 3);
});

await test('资料卡点赞：省略次数默认 10 次', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 111, nickname: '示例好友甲', remark: '' });
  const reply = await cmd('[资料卡点赞] [示例好友甲]');
  assert.match(reply, /资料卡点赞 10 次/);
  assert.equal(calls.profileLikes[0].user_id, 111);
  assert.equal(calls.profileLikes[0].times, 10);
});

await test('资料卡点赞：超过 10 次按 10 次并提示', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 111, nickname: '示例好友甲', remark: '' });
  const reply = await cmd('[资料卡点赞] [示例好友甲] [20]');
  assert.match(reply, /已按 10 次/);
  assert.equal(calls.profileLikes[0].user_id, 111);
  assert.equal(calls.profileLikes[0].times, 10);
});

await test('资料卡点赞：重名先列候选，再按序号选择', async () => {
  resetSocial();
  calls.qzoneFriends.push(
    { user_id: 111, nickname: '示例好友甲', remark: '' },
    { user_id: 222, nickname: '示例好友甲', remark: '老王' }
  );
  const first = await cmd('[资料卡点赞] [示例好友甲] [5]');
  assert.match(first, /找到 2 个「示例好友甲」/);
  assert.match(first, /1\. 示例好友甲（QQ 111）/);
  assert.match(first, /2\. 示例好友甲（QQ 222，备注：老王）/);
  assert.equal(calls.profileLikes.length, 0);
  const second = await cmd('[资料卡点赞 2] [5]');
  assert.match(second, /已给「老王」（QQ 222）资料卡点赞 5 次/);
  assert.equal(calls.profileLikes[0].user_id, 222);
  assert.equal(calls.profileLikes[0].times, 5);
});

await test('资料卡点赞：直接用 QQ 号', async () => {
  resetSocial();
  const reply = await cmd('[资料卡点赞] [7770486] [5]');
  assert.match(reply, /已给 QQ 7770486 资料卡点赞 5 次/);
  assert.equal(calls.profileLikes[0].user_id, 7770486);
  assert.equal(calls.profileLikes[0].times, 5);
  assert.equal(calls.qzoneFriends.length, 0);
});

await test('资料卡点赞：找不到好友', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 111, nickname: '别人', remark: '' });
  const reply = await cmd('[资料卡点赞] [示例好友甲] [5]');
  assert.match(reply, /没找到好友「示例好友甲」/);
  assert.equal(calls.profileLikes.length, 0);
});

await test('资料卡点赞：帮助返回完整用法', async () => {
  resetSocial();
  const reply = await cmd('[资料卡点赞]');
  assert.match(reply, /好友资料卡点赞 · 用法/);
  assert.match(reply, /\[资料卡点赞\] \[示例好友甲\] \[10\]/);
  assert.match(reply, /重名好友/);
  assert.equal(calls.profileLikes.length, 0);
});

await test('好友申请：记录验证消息并通知 owner', async () => {
  resetSocial();
  resetFriendRequests();
  await bridge.handleFriendRequestEvent({ user_id: 123456, comment: '我是群里的某某', flag: 'uid_abc', time: Math.floor(Date.now() / 1000) });
  const st = bridge.getFriendRequestState();
  assert.equal(st.requests.length, 1);
  assert.equal(st.requests[0].comment, '我是群里的某某');
  assert.equal(st.requests[0].uin, 123456);
  const text = calls.sent.map((m) => m.text).join('\n');
  assert.match(text, /【好友申请】fr_/);
  assert.match(text, /QQ：123456/);
  assert.match(text, /验证消息：「我是群里的某某」/);
  assert.match(text, /对方申请加你/);
  assert.match(text, /\[通过申请 fr_/);
});

await test('好友申请：按序号通过后会调 set_friend_add_request', async () => {
  resetSocial();
  resetFriendRequests();
  await bridge.handleFriendRequestEvent({ user_id: 123456, comment: '我是群里的某某', flag: 'uid_abc', time: Math.floor(Date.now() / 1000) });
  calls.sent.length = 0;
  const reply = await cmd('[通过申请 1]');
  assert.match(reply, /已通过好友申请 fr_/);
  assert.equal(calls.friendRequestHandles.length, 1);
  assert.equal(calls.friendRequestHandles[0].flag, 'uid_abc');
  assert.equal(calls.friendRequestHandles[0].approve, true);
  assert.equal(bridge.getFriendRequestState().requests[0].status, 'approved');
});

await test('好友申请：通过后 friend_add 标记为对方加你', async () => {
  const st = bridge.getFriendRequestState();
  calls.sent.length = 0;
  await bridge.handleFriendAddedEvent({ user_id: 123456 });
  const rec = st.friends[123456];
  assert.equal(rec.direction, 'incoming');
  assert.equal(rec.comment, '我是群里的某某');
  assert.match(calls.sent.map((m) => m.text).join('\n'), /来源：对方申请加你/);
});

await test('新好友：没有申请记录时标为来源不确定，不猜', async () => {
  resetFriendRequests();
  calls.sent.length = 0;
  await bridge.handleFriendAddedEvent({ user_id: 654321 });
  const st = bridge.getFriendRequestState();
  assert.equal(st.friends[654321].direction, 'unknown');
  const text = calls.sent.map((m) => m.text).join('\n');
  assert.match(text, /没匹配到好友申请记录/);
});

await test('好友申请：列表和来源查询', async () => {
  resetSocial();
  resetFriendRequests();
  await bridge.handleFriendRequestEvent({ user_id: 123456, comment: '我是群里的某某', flag: 'uid_abc', time: Math.floor(Date.now() / 1000) });
  const list = await cmd('[好友申请]');
  assert.match(list, /待处理好友申请】1 条/);
  assert.match(list, /验证消息：「我是群里的某某」/);
  const source = await cmd('[好友来源 123456]');
  assert.match(source, /对方申请加你/);
  assert.match(source, /验证消息：「我是群里的某某」/);
});

await test('好友来源：注入私聊提示词，不乱问', async () => {
  const st = bridge.getFriendRequestState();
  st.requests[0].status = 'approved';
  st.requests[0].handledAt = Date.now();
  await bridge.handleFriendAddedEvent({ user_id: 123456 });
  const prompt = await bridge.buildWakePromptV2('private:123456', 'private');
  assert.match(prompt, /【好友来源】/);
  assert.match(prompt, /对方申请加你/);
  assert.match(prompt, /不要问“你是谁\/怎么加的我”/);
});

await test('好友来源：手动标注“我加对方”并注入提示词', async () => {
  resetSocial();
  resetFriendRequests();
  calls.qzoneFriends.push({ user_id: 123456, nickname: 'A', remark: '阿明' });
  const reply = await cmd('[好友来源 设置] [123456] [我加对方] [一起打游戏加的]');
  assert.match(reply, /已记录好友来源/);
  assert.match(reply, /你主动加对方/);
  const st = bridge.getFriendRequestState();
  assert.equal(st.friends[123456].direction, 'outgoing');
  assert.equal(st.friends[123456].comment, '一起打游戏加的');
  const prompt = await bridge.buildWakePromptV2('private:123456', 'private');
  assert.match(prompt, /你是主动加对方的/);
  assert.match(prompt, /一起打游戏加的/);
});

await test('好友来源：同一会话只注入一次', async () => {
  const st = bridge.getSocialV2State('private:123456');
  st.friendSourceInjected = false;
  const first = await bridge.buildWakePromptV2('private:123456', 'private');
  assert.match(first, /【好友来源】/);
  st.friendSourceInjected = true;
  const second = await bridge.buildWakePromptV2('private:123456', 'private');
  assert.doesNotMatch(second, /【好友来源】/);
});

await test('好友快照：首次只建快照，之后新增标记来源不确定', async () => {
  resetSocial();
  resetFriendRequests();
  calls.sent.length = 0;
  calls.qzoneFriends.push({ user_id: 111, nickname: 'A', remark: '' });
  await bridge.syncFriendSnapshot();
  assert.equal(bridge.getFriendRequestState().snapshot.uins.length, 1);
  assert.equal(calls.sent.length, 0);
  calls.qzoneFriends.push({ user_id: 222, nickname: 'B', remark: '' });
  await bridge.syncFriendSnapshot();
  assert.equal(bridge.getFriendRequestState().friends[222].direction, 'unknown');
  assert.match(calls.sent.map((m) => m.text).join('\n'), /没匹配到好友申请记录/);
});

await test('好友查看：全部好友带 QQ 号，过滤自己和设备', async () => {
  resetSocial();
  calls.qzoneFriends.push(
    { user_id: 7770486, nickname: '示例好友甲', remark: '' },
    { user_id: 123456, nickname: 'A', remark: '阿明' },
    { user_id: SELF_UIN, nickname: '樱良', remark: '' },
    { user_id: 2113929217, nickname: '我的电脑', remark: '' },
    { user_id: 2113929218, nickname: '我的手机', remark: '' }
  );
  const reply = await cmd('[查看你全部好友]');
  assert.match(reply, /【全部好友】共 2 人/);
  assert.match(reply, /示例好友甲\(7770486\)/);
  assert.match(reply, /阿明\(123456\)/);
  assert.doesNotMatch(reply, /樱良\(2867977191\)/);
  assert.doesNotMatch(reply, /我的电脑/);
  assert.doesNotMatch(reply, /我的手机/);
});

await test('好友查看：最近最活跃按收到消息数排序，不含 owner', async () => {
  resetSocial();
  calls.qzoneFriends.push(
    { user_id: 7770486, nickname: '示例好友甲', remark: '' },
    { user_id: 123456, nickname: 'A', remark: '阿明' },
    { user_id: OWNER, nickname: 'owner', remark: '' }
  );
  const now = Date.now();
  bridge.getSocialV2State('private:7770486').recentMessages = [
    { isSelf: false, time: now - 1000, text: 'a' },
    { isSelf: false, time: now - 2000, text: 'b' },
    { isSelf: true, time: now - 500, text: 'c' }
  ];
  bridge.getSocialV2State('private:123456').recentMessages = [
    { isSelf: false, time: now - 3000, text: 'd' }
  ];
  bridge.getSocialV2State(`private:${OWNER}`).recentMessages = [
    { isSelf: false, time: now - 1000, text: 'e' },
    { isSelf: false, time: now - 2000, text: 'f' },
    { isSelf: false, time: now - 3000, text: 'g' }
  ];
  const reply = await cmd('[查看你最近最活跃的2个好友]');
  assert.match(reply, /【最近活跃好友】近 7 天（按收到消息数排序，不含你）/);
  assert.match(reply, /1\. 示例好友甲\(7770486\)  2 条/);
  assert.match(reply, /2\. 阿明\(123456\)  1 条/);
  assert.doesNotMatch(reply, /owner\(123\)/);
});

await test('好友查看：对话用合并转发，不逐条发、不进记忆', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 7770486, nickname: '示例好友甲', remark: '' });
  calls.friendHistory.push(
    { user_id: 7770486, sender: { nickname: '示例好友甲' }, message: [{ type: 'text', data: { text: '在吗' } }], time: 1792425000 },
    { user_id: 2867977191, sender: {}, message: [{ type: 'text', data: { text: '在' } }], time: 1792425060 }
  );
  const before = bridge.getSocialV2State(`private:${OWNER}`).recentMessages.length;
  const reply = await cmd('[查看示例好友甲最近2条对话]');
  const after = bridge.getSocialV2State(`private:${OWNER}`).recentMessages.length;
  assert.equal(after, before, 'owner recentMessages 不应增加');
  assert.equal(calls.privateForwards.length, 1);
  assert.equal(calls.privateForwards[0].user_id, OWNER);
  assert.equal(calls.privateForwards[0].messages.length, 2);
  assert.deepEqual(calls.privateForwards[0].messages[0].data.content, [{ type: 'text', data: { text: '在吗' } }]);
  assert.deepEqual(calls.privateForwards[0].messages[1].data.content, [{ type: 'text', data: { text: '在' } }]);
  assert.match(reply, /已转发与「示例好友甲」\(7770486\) 的最近 2 条对话/);
  assert.equal(calls.sent.filter((m) => m.kind === 'private').length, 1, '只发一条确认，不逐条刷屏');
});

await test('好友查看：对话转发保留图片/表情', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 7770486, nickname: '示例好友甲', remark: '' });
  calls.friendHistory.push({
    user_id: 7770486,
    sender: { nickname: '示例好友甲' },
    time: 1792425000,
    message: [
      { type: 'text', data: { text: '看图' } },
      { type: 'image', data: { file: 'abc.jpg', url: 'https://example.com/a.jpg' } },
      { type: 'face', data: { id: '277' } }
    ]
  });
  await cmd('[查看示例好友甲最近1条对话]');
  assert.equal(calls.privateForwards.length, 1);
  assert.deepEqual(calls.privateForwards[0].messages[0].data.content, [
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { url: 'https://example.com/a.jpg' } },
    { type: 'face', data: { id: '277' } }
  ]);
});

await test('好友查看：媒体转发失败时退回文字版', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 7770486, nickname: '示例好友甲', remark: '' });
  calls.friendHistory.push({
    user_id: 7770486,
    sender: { nickname: '示例好友甲' },
    time: 1792425000,
    message: [
      { type: 'text', data: { text: '看图' } },
      { type: 'image', data: { url: 'https://example.com/a.jpg' } }
    ]
  });
  calls.privateForwardFailOnce = true;
  const reply = await cmd('[查看示例好友甲最近1条对话]');
  assert.match(reply, /已改为文字版/);
  assert.equal(calls.privateForwards.length, 2);
  assert.deepEqual(calls.privateForwards[0].messages[0].data.content, [
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { url: 'https://example.com/a.jpg' } }
  ]);
  assert.deepEqual(calls.privateForwards[1].messages[0].data.content, [
    { type: 'text', data: { text: '看图[图片]' } }
  ]);
});

await test('好友查看：转发彻底失败时给出错误提示', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 7770486, nickname: '示例好友甲', remark: '' });
  calls.friendHistory.push({
    user_id: 7770486,
    sender: { nickname: '示例好友甲' },
    time: 1792425000,
    message: [{ type: 'text', data: { text: '在吗' } }]
  });
  calls.privateForwardFail = true;
  const reply = await cmd('[查看示例好友甲最近1条对话]');
  assert.match(reply, /转发对话失败/);
  assert.equal(calls.privateForwards.length, 2);
});

await test('好友查看：重名要求用 QQ 号重发', async () => {
  resetSocial();
  calls.qzoneFriends.push(
    { user_id: 111111, nickname: '示例好友甲', remark: '' },
    { user_id: 222222, nickname: '示例好友甲', remark: '老王' }
  );
  const reply = await cmd('[查看示例好友甲最近5条对话]');
  assert.match(reply, /找到 2 个「示例好友甲」/);
  assert.match(reply, /请用 QQ 号重发/);
  assert.equal(calls.privateForwards.length, 0);
});

await test('指令引导：好友查看写错给出提示，不进记忆', async () => {
  resetSocial();
  const before = bridge.getSocialV2State(`private:${OWNER}`).recentMessages.length;
  const reply = await cmd('[查看你全部好友啊]');
  const after = bridge.getSocialV2State(`private:${OWNER}`).recentMessages.length;
  assert.equal(after, before, '引导不应写入 recentMessages');
  assert.match(reply, /【指令没听懂】/);
  assert.match(reply, /\[查看你全部好友\]/);
  assert.match(reply, /\[指令\]/);
});

await test('指令引导：好友申请写错给出提示', async () => {
  resetSocial();
  const reply = await cmd('[通过申请]');
  assert.match(reply, /好友申请指令，但格式不对/);
  assert.match(reply, /\[通过申请 1\]/);
});

await test('指令引导：普通聊天不拦截', async () => {
  resetSocial();
  const reply = await cmd('查看了一下今天天气');
  assert.doesNotMatch(reply, /指令没听懂/);
});

await test('好友查看：引用图片保留（目标在历史里）', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 7770486, nickname: '示例好友甲', remark: '' });
  calls.friendHistory.push(
    {
      message_id: '1892292496',
      user_id: 7770486,
      sender: { nickname: '示例好友甲' },
      time: 100,
      message: [{ type: 'image', data: { url: 'https://example.com/a.jpg', sub_type: 1, summary: '[动画表情]' } }]
    },
    {
      message_id: '647221224',
      user_id: 2867977191,
      sender: { nickname: '樱良' },
      time: 101,
      message: [
        { type: 'reply', data: { id: '1892292496' } },
        { type: 'text', data: { text: '这牙一露' } }
      ]
    }
  );
  await cmd('[查看示例好友甲最近2条对话]');
  const content = calls.privateForwards[0].messages[1].data.content;
  assert.match(content[0].data.text, /【引用 示例好友甲\(7770486\): /);
  assert.deepEqual(content[1], { type: 'image', data: { url: 'https://example.com/a.jpg', sub_type: 1, summary: '[动画表情]' } });
  assert.equal(content[3].data.text, '这牙一露');
});

await test('好友查看：引用目标不在历史时用 get_msg 补拉', async () => {
  resetSocial();
  calls.qzoneFriends.push({ user_id: 7770486, nickname: '示例好友甲', remark: '' });
  calls.friendHistory.push({
    message_id: '647221224',
    user_id: 2867977191,
    sender: { nickname: '樱良' },
    time: 101,
    message: [
      { type: 'reply', data: { id: '1892292496' } },
      { type: 'text', data: { text: '这牙一露' } }
    ]
  });
  calls.getMessageData['1892292496'] = {
    message_id: '1892292496',
    user_id: 7770486,
    sender: { nickname: '示例好友甲' },
    time: 100,
    message: [{ type: 'image', data: { url: 'https://example.com/a.jpg', sub_type: 0, summary: '[图片]' } }]
  };
  await cmd('[查看示例好友甲最近1条对话]');
  const content = calls.privateForwards[0].messages[0].data.content;
  assert.match(content[0].data.text, /【引用 示例好友甲\(7770486\): /);
  assert.deepEqual(content[1], { type: 'image', data: { url: 'https://example.com/a.jpg', sub_type: 0, summary: '[图片]' } });
});

await test('群聊记录：按群号合并转发，不进记忆', async () => {
  resetSocial();
  calls.groups.push({ group_id: 7000001, group_name: '测试群聊', member_count: 4 });
  calls.groupHistory.push(
    { user_id: 7770486, sender: { nickname: '示例好友甲', card: '' }, message: [{ type: 'text', data: { text: '在吗' } }], time: 1792425000 },
    { user_id: 2867977191, sender: { nickname: '樱良', card: '' }, message: [{ type: 'text', data: { text: '在' } }], time: 1792425060 }
  );
  const before = bridge.getSocialV2State(`private:${OWNER}`).recentMessages.length;
  const reply = await cmd('[查看群聊 7000001 最近2条对话]');
  const after = bridge.getSocialV2State(`private:${OWNER}`).recentMessages.length;
  assert.equal(after, before, '群聊转发不应写入 owner recentMessages');
  assert.equal(calls.privateForwards.length, 1);
  assert.equal(calls.privateForwards[0].user_id, OWNER);
  assert.equal(calls.privateForwards[0].messages.length, 2);
  assert.deepEqual(calls.privateForwards[0].messages[0].data.content, [{ type: 'text', data: { text: '在吗' } }]);
  assert.deepEqual(calls.privateForwards[0].messages[1].data.content, [{ type: 'text', data: { text: '在' } }]);
  assert.match(reply, /已转发群「测试群聊」\(7000001\) 的最近 2 条消息/);
});

await test('群聊记录：群名带空格 / 重名 / 找不到', async () => {
  resetSocial();
  calls.groups.push({ group_id: 111111, group_name: '深夜 闲聊 群', member_count: 3 });
  calls.groupHistory.push({ user_id: 7770486, sender: { nickname: '示例好友甲' }, message: [{ type: 'text', data: { text: '晚安' } }], time: 1792425000 });
  const byName = await cmd('[查看群聊 深夜 闲聊 群 最近1条对话]');
  assert.match(byName, /已转发群「深夜 闲聊 群」\(111111\)/);

  resetSocial();
  calls.groups.push(
    { group_id: 222222, group_name: '重名群', member_count: 3 },
    { group_id: 333333, group_name: '重名群', member_count: 4 }
  );
  const dup = await cmd('[查看群聊 重名群]');
  assert.match(dup, /找到 2 个「重名群」/);
  assert.match(dup, /请用群号重发/);
  assert.equal(calls.privateForwards.length, 0);

  resetSocial();
  const missing = await cmd('[查看群聊 不存在的群]');
  assert.match(missing, /没找到群「不存在的群」/);
});

await test('好友申请：可疑/离线申请列表 + 按 df id 通过', async () => {
  resetSocial();
  resetFriendRequests();
  calls.doubtFriendRequests.push({
    uid: 'u_test12345678', user_id: 123456, nick: '小明', source: '群聊',
    reason: '', msg: '我是群里的', group_code: '7000001', reqTime: Date.now()
  });
  const list = await cmd('[好友申请]');
  assert.match(list, /可疑\/离线好友申请】1 条/);
  assert.match(list, /小明/);
  const id = (list.match(/df_[a-z0-9]+/i) || [])[0];
  assert.ok(id, '列表应包含 df_ id');
  const pass = await cmd(`[通过申请 ${id}]`);
  assert.match(pass, /已通过可疑好友申请/);
  assert.equal(calls.doubtFriendHandles.length, 1);
  assert.equal(calls.doubtFriendHandles[0].flag, 'u_test12345678');
  assert.equal(calls.doubtFriendHandles[0].approve, true);
});

await test('管理员：入群申请列表 + 按序号通过', async () => {
  resetSocial();
  calls.groupSystemMsgs.push({
    group_id: 7000001, group_name: '测试群聊', request_id: 7,
    requester_uin: 123456, requester_nick: '申请人', invitor_uin: 0, invitor_nick: '',
    message: '想进群', checked: false, flag: 'flag_test_1'
  });
  const list = await cmd('[入群申请]');
  assert.match(list, /【入群申请】1 条/);
  assert.match(list, /申请人\(123456\)/);
  assert.match(list, /\[通过入群 1\]/);
  const pass = await cmd('[通过入群 1]');
  assert.match(pass, /已通过入群申请/);
  assert.equal(calls.groupAddRequests.length, 1);
  assert.equal(calls.groupAddRequests[0].flag, 'flag_test_1');
  assert.equal(calls.groupAddRequests[0].approve, true);
});

await test('管理员：踢人/退群/删好友必须带确认', async () => {
  resetSocial();
  const noConfirm = await cmd('[踢人 7000001 7770486]');
  assert.match(noConfirm, /危险操作/);
  assert.equal(calls.kicks.length, 0);
  const kick = await cmd('[踢人 7000001 7770486 确认]');
  assert.match(kick, /已踢出/);
  assert.equal(calls.kicks[0].group_id, 7000001);
  assert.equal(calls.kicks[0].user_id, 7770486);

  await cmd('[退群 7000001 确认]');
  assert.equal(calls.groupLeaves[0].group_id, 7000001);
  await cmd('[删好友 7770486 确认]');
  assert.equal(calls.deletedFriends[0].user_id, 7770486);
});

await test('管理员：禁言/解禁/全员禁言/改名片/改群名/设管理', async () => {
  resetSocial();
  const warn = await cmd('[禁言 7000001 7770486 30]');
  assert.match(warn, /危险操作：禁言/);
  assert.equal(calls.bans.length, 0);
  await cmd('[禁言 7000001 7770486 30 确认]');
  assert.equal(calls.bans[0].duration, 1800);
  await cmd('[解禁 7000001 7770486]');
  assert.equal(calls.bans[1].duration, 0);
  await cmd('[全员禁言 7000001 on 确认]');
  assert.equal(calls.wholeBans[0].enable, true);
  await cmd('[改名片 7000001 7770486 大 肥 鱼 确认]');
  assert.equal(calls.groupCards[0].card, '大 肥 鱼');
  await cmd('[改群名 7000001 新 群 名 确认]');
  assert.equal(calls.groupNames[0].group_name, '新 群 名');
  await cmd('[设管理 7000001 7770486 on 确认]');
  assert.equal(calls.groupAdmins[0].enable, true);
});

await test('管理员：撤回/查QQ/改备注', async () => {
  resetSocial();
  const warn = await cmd('[撤回 -123456789]');
  assert.match(warn, /危险操作：撤回消息/);
  assert.equal(calls.deletedMsgs.length, 0);
  await cmd('[撤回 -123456789 确认]');
  assert.equal(calls.deletedMsgs[0].message_id, -123456789);
  const info = await cmd('[查QQ 7770486]');
  assert.match(info, /stranger-7770486/);
  await cmd('[改备注 7770486 老同学]');
  assert.equal(calls.friendRemarks[0].remark, '老同学');
  const help = await cmd('[管理帮助]');
  assert.match(help, /管理指令 · 用法/);
});

await test('控制台：[状态] 汇总', async () => {
  resetSocial();
  const reply = await cmd('[状态]');
  assert.match(reply, /【机器人状态】/);
  assert.match(reply, /模式：reserved2/);
  assert.match(reply, /待处理评论：/);
});

await test('控制台：[会话列表] / [群列表] / [群成员]', async () => {
  resetSocial();
  bridge.getSocialV2State('private:7770486').lastIncomingAt = Date.now();
  const conv = await cmd('[会话列表]');
  assert.match(conv, /【会话列表】/);
  assert.match(conv, /private:7770486/);

  calls.groups.push({ group_id: 7000001, group_name: '樱良、那年夏末、示例昵称、', member_count: 4 });
  const groups = await cmd('[群列表]');
  assert.match(groups, /【群列表】1 个/);
  assert.match(groups, /樱良、那年夏末、示例昵称、\(7000001\)  4 人/);

  calls.groupMembers.push({ user_id: 7770486, card: '示例好友甲', nickname: '示例好友甲' });
  const members = await cmd('[群成员 7000001]');
  assert.match(members, /【群成员】7000001｜1 人/);
  assert.match(members, /示例好友甲\(7770486\)/);
});

await test('控制台：[提醒列表] / [取消提醒]', async () => {
  resetSocial();
  bridge.getReminders().set('private:7770486', [
    { id: 'r_12345678', at: Date.parse('2026-10-20T09:00:00+08:00'), text: '出门走走', createdAt: Date.now(), repeat: null }
  ]);
  const list = await cmd('[提醒列表]');
  assert.match(list, /【提醒列表】1 条/);
  assert.match(list, /r_12345678/);
  assert.match(list, /出门走走/);
  const cancel = await cmd('[取消提醒 r_12345678]');
  assert.match(cancel, /已取消提醒 r_12345678/);
  assert.equal(bridge.getReminders().get('private:7770486').length, 0);
});

await test('控制台：[余额] 查询 DeepSeek 余额', async () => {
  resetSocial();
  const reply = await cmd('[余额]');
  assert.match(reply, /【DeepSeek 余额】可用/);
  assert.match(reply, /总余额 ¥27\.45/);
  assert.match(reply, /充值 ¥27\.45/);
});

await test('控制台：[最近错误] 无日志时也给提示', async () => {
  resetSocial();
  const reply = await cmd('[最近错误]');
  assert.match(reply, /最近没有错误日志|【最近错误】/);
});

await test('好友动态查询：[评论 N] 内容 直接发送', async () => {
  resetSocial();
  calls.qzoneFeeds.push(feed({ key: TID(1), time: nowSec() - 3600 }));
  await cmd('查看好友动态 最近3天 最多5条');
  const reply = await cmd('[评论 1] 看着就香');
  assert.match(reply, /已评论第 1 条/);
  assert.equal(calls.qzoneComments.length, 1);
  assert.equal(calls.qzoneComments[0].content, '看着就香');
  assert.ok(bridge.getQzoneSocialState().seen[TID(1)].commentedAt > 0);
});

await test('好友动态查询：[删除评论 N] 删除机器人评论', async () => {
  resetSocial();
  calls.qzoneFeeds.push(feed({ key: TID(1), time: nowSec() - 3600 }));
  await cmd('查看好友动态 最近3天 最多5条');
  seedSeen(feed({ key: TID(1) }), { commentId: '3' });
  const reply = await cmd('[删除评论 1]');
  assert.match(reply, /已删除第 1 条/);
  assert.equal(calls.qzoneCommentDeletes.length, 1);
  assert.equal(calls.qzoneCommentDeletes[0].comment_id, '3');
});

await test('好友动态查询：[查看评论 N] 列出评论', async () => {
  resetSocial();
  calls.qzoneFeeds.push(feedWithComments());
  await cmd('查看好友动态 最近3天 最多5条');
  const reply = await cmd('[查看评论 1]');
  assert.match(reply, /第 1 条评论/);
  assert.match(reply, /樱良（你）/);
  assert.match(reply, /是吧，下次一起/);
});

await test('好友动态查询：结果过期后操作被拒', async () => {
  resetSocial();
  const st = bridge.getQzoneSocialState();
  st.lastQuery = {
    id: 'q_old',
    createdAt: 0,
    expiresAt: Date.now() - 1,
    who: 'all',
    from: 0,
    to: Date.now(),
    limit: 5,
    items: [{ index: 1, tid: TID(1), uin: 111, nickname: 'x', time: 0, text: '', commentNum: 0 }]
  };
  const reply = await cmd('[点赞 1]');
  assert.match(reply, /已过期/);
  assert.equal(calls.qzoneLikes.length, 0);
});

await test('owner 命令：status', async () => {
  resetSocial();
  const reply = await cmd('/qzone social status');
  assert.match(reply, /空间互动/);
  assert.match(reply, /点赞/);
  assert.match(reply, /评论/);
});

await test('owner 命令：off/on 与 like/comment 开关', async () => {
  resetSocial();
  await cmd('/qzone social off');
  assert.equal(bridge.getQzoneSocialState().enabled, false);
  await cmd('/qzone social on');
  assert.equal(bridge.getQzoneSocialState().enabled, true);
  await cmd('/qzone social like off');
  assert.equal(bridge.getQzoneSocialState().likeEnabled, false);
  await cmd('/qzone social comment off');
  assert.equal(bridge.getQzoneSocialState().commentEnabled, false);
});

await test('owner 命令：now dry 只列候选', async () => {
  resetSocial();
  calls.qzoneFeeds.push(feed());
  const reply = await cmd('/qzone social now dry');
  assert.match(reply, /dry-run/);
  assert.equal(calls.qzoneLikes.length, 0);
  assert.equal(calls.qzoneComments.length, 0);
});

await test('owner 命令：feed 列出好友动态', async () => {
  resetSocial();
  calls.qzoneFeeds.push(feed(), feed({ key: TID(2), appid: 6600, uin: 0, nickname: '' }));
  const reply = await cmd('/qzone social feed');
  assert.match(reply, /好友动态/);
  assert.match(reply, /可互动 1/);
});

await test('删除评论：owner 命令按 tid + comment_id 删除', async () => {
  resetSocial();
  const item = feedWithComments();
  seedCommented(item, { commentId: '3' });
  const reply = await cmd(`/qzone social delete ${item.key} 3`);
  assert.match(reply, /已删除评论/);
  assert.equal(calls.qzoneCommentDeletes.length, 1);
  assert.equal(calls.qzoneCommentDeletes[0].tid, item.key);
  assert.equal(calls.qzoneCommentDeletes[0].target_uin, item.uin);
  assert.equal(calls.qzoneCommentDeletes[0].comment_id, '3');
  const entry = bridge.getQzoneSocialState().seen[item.key];
  assert.ok(entry.commentDeletedAt > 0);
  assert.equal(entry.commentId, '');
  assert.equal(entry.comment, '');
});

await test('删除评论：省略 comment_id 时用 state 里存的 id', async () => {
  resetSocial();
  const item = feedWithComments();
  seedCommented(item, { commentId: '7' });
  const reply = await cmd(`/qzone social delete ${item.key}`);
  assert.match(reply, /已删除评论 7/);
  assert.equal(calls.qzoneCommentDeletes.length, 1);
  assert.equal(calls.qzoneCommentDeletes[0].comment_id, '7');
});

await test('owner 命令：undo 调 unlike_qzone', async () => {
  resetSocial();
  const item = feed();
  bridge.getQzoneSocialState().seen[item.key] = { uin: item.uin, time: item.time, likedAt: Date.now() };
  const reply = await cmd(`/qzone social undo ${item.key}`);
  assert.match(reply, /已取消点赞/);
  assert.equal(calls.qzoneUnlikes.length, 1);
  assert.equal(calls.qzoneUnlikes[0].tid, item.key);
  assert.equal(bridge.getQzoneSocialState().seen[item.key].likedAt, 0);
});

await bridge.close();
console.log(`\n${passed} passed`);
