// 好友查看指令：纯解析/格式化，不做 I/O。
//
// owner 私聊：
//   [查看你全部好友]
//   [查看你最近最活跃的 5 个好友]
//   [查看示例好友甲最近 20 条对话]
//   [查看 7770486 最近 50 条对话]
//
// 对话用合并转发发送（send_private_forward_msg），不逐条刷屏；
// 这些指令都在 handleIncoming 早期拦截，不写 recentMessages/unread。

const DEFAULT_ACTIVE = 5;
const MAX_ACTIVE = 20;
const DEFAULT_CHAT = 20;
// SnowLuma 的 QQ 服务器拉取在 count=150 时只回部分、count=200 时直接回 0 条；
// 实测 100 稳定，所以上限压到 100。
const MAX_CHAT = 100;

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function parseCountNumber(value) {
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + (CN_DIGITS[s[1]] ?? NaN);
  if (s.length === 2 && s[1] === '十') return (CN_DIGITS[s[0]] ?? NaN) * 10;
  if (s.length === 3 && s[1] === '十') return (CN_DIGITS[s[0]] ?? NaN) * 10 + (CN_DIGITS[s[2]] ?? NaN);
  if (s.length === 1) return CN_DIGITS[s] ?? NaN;
  return NaN;
}

function clampCount(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.round(n)));
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function bjShort(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime()) || Number(ms) <= 0) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const FRIEND_VIEW_HELP = [
  '【好友查看 · 用法】',
  '查看全部好友：',
  '  [查看你全部好友]',
  '',
  '查看最近最活跃的好友（默认 5 个，最多 20 个）：',
  '  [查看你最近最活跃的 5 个好友]',
  '',
  '查看与某个好友的最近对话（默认 20 条，最多 100 条）：',
  '  [查看示例好友甲最近 20 条对话]',
  '  [查看 7770486 最近 50 条对话]',
  '',
  '说明：对话用合并转发发送，不逐条刷屏；这些指令不会进机器人的聊天记忆。'
].join('\n');

/** 解析好友查看指令。 */
export function parseFriendViewCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false };
  const s = raw
    .replace(/[【\[]/g, ' ')
    .replace(/[】\]]/g, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { ok: false };
  const compact = s.replace(/\s+/g, '');

  if (/^(?:好友查看帮助|查看好友帮助|好友列表帮助)$/.test(compact)) {
    return { ok: true, action: 'help', raw };
  }
  if (/^(?:查看)?(?:你)?(?:的)?(?:全部|所有)好友(?:列表)?$/.test(compact)
    || /^(?:好友列表|全部好友|所有好友)$/.test(compact)) {
    return { ok: true, action: 'listAll', raw };
  }

  let m = s.match(/^(?:查看)?(?:你)?(?:最近)?最活跃的?\s*([0-9一二两三四五六七八九十]+)?\s*个?\s*好友$/);
  if (m) {
    const n = m[1] ? parseCountNumber(m[1]) : DEFAULT_ACTIVE;
    return { ok: true, action: 'listActive', count: clampCount(n, DEFAULT_ACTIVE, MAX_ACTIVE), raw };
  }

  m = s.match(/^查看\s*(.+?)\s*(?:的)?\s*最近\s*([0-9一二两三四五六七八九十]+)\s*条\s*(?:对话|聊天|聊天记录|消息|记录)$/);
  if (m) {
    return {
      ok: true,
      action: 'chat',
      target: m[1].trim(),
      count: clampCount(parseCountNumber(m[2]), DEFAULT_CHAT, MAX_CHAT),
      raw
    };
  }
  m = s.match(/^查看\s*(.+?)\s*(?:的)?\s*最近\s*(?:对话|聊天|聊天记录|消息|记录)$/);
  if (m) {
    return { ok: true, action: 'chat', target: m[1].trim(), count: DEFAULT_CHAT, raw };
  }
  return { ok: false };
}

/** 全部好友：每行「备注或昵称(QQ)」，按名字排序。 */
export function formatFriendList(friends) {
  const rows = (Array.isArray(friends) ? friends : [])
    .map((f) => ({
      uin: Math.max(0, Number(f?.user_id ?? f?.uin) || 0),
      name: String(f?.remark || f?.nickname || '').trim()
    }))
    .filter((f) => f.uin > 0);
  if (!rows.length) return '好友列表为空。';
  rows.sort((a, b) => (a.name || String(a.uin)).localeCompare(b.name || String(b.uin), 'zh-CN'));
  return [`【全部好友】共 ${rows.length} 人`, ...rows.map((f) => `${f.name || '未命名'}(${f.uin})`)].join('\n');
}

/** 最近活跃好友：rows = [{uin,name,count,lastAt}]，已排序。 */
export function formatActiveFriends(rows, days = 7, { excludeOwner = false } = {}) {
  if (!Array.isArray(rows) || !rows.length) return `近 ${days} 天没有好友消息记录。`;
  const lines = [`【最近活跃好友】近 ${days} 天（按收到消息数排序${excludeOwner ? '，不含你' : ''}）`];
  rows.forEach((r, i) => {
    const last = bjShort(r.lastAt);
    lines.push(`${i + 1}. ${r.name}(${r.uin})  ${r.count} 条${last ? `  最后 ${last}` : ''}`);
  });
  return lines.join('\n');
}

/** 从 OneBot 消息事件里取可读文本，媒体用占位符，避免转发时重新上传。 */
export function messageEventToText(event, { nameMap = null, quoteIndex = null, depth = 0 } = {}) {
  const segments = Array.isArray(event?.message) ? event.message : null;
  if (segments && segments.length) {
    const parts = [];
    for (const seg of segments) {
      const type = String(seg?.type ?? '');
      const d = seg?.data && typeof seg.data === 'object' ? seg.data : {};
      if (type === 'text') parts.push(String(d.text ?? ''));
      else if (type === 'face') parts.push('[表情]');
      else if (type === 'image') parts.push('[图片]');
      else if (type === 'record' || type === 'voice') parts.push('[语音]');
      else if (type === 'video') parts.push('[视频]');
      else if (type === 'file') parts.push(`[文件${d.name ? ` ${d.name}` : ''}]`);
      else if (type === 'forward') parts.push('[聊天记录]');
      else if (type === 'at') {
        const name = String(d.name || '').trim();
        const qq = String(d.qq || '').trim();
        const mapped = qq && nameMap ? String(nameMap[qq] || '').trim() : '';
        parts.push(name ? `@${name}` : mapped ? `@${mapped}` : qq === 'all' ? '@全体成员' : qq ? `@${qq}` : '@某人');
      } else if (type === 'reply') {
        const id = String(d.id ?? '').trim();
        const target = quoteIndex && id ? quoteIndex.get(id) : null;
        if (depth === 0 && target && target !== event) {
          const sender = target.sender && typeof target.sender === 'object' ? target.sender : {};
          const nick = String(sender.card || sender.nickname || target.user_id || '未知');
          const uin = Number(target.user_id) || 0;
          const quotedText = messageEventToText(target, { nameMap, quoteIndex, depth: 1 });
          if (quotedText) parts.push(`【引用 ${nick}${uin ? `(${uin})` : ''}: ${quotedText}】`);
        }
      }
      else if (type) parts.push(`[${type}]`);
    }
    const text = decodeHtmlEntities(parts.join('').trim());
    if (text) return text;
  }
  const raw = decodeHtmlEntities(String(event?.raw_message ?? '').trim());
  if (raw && !/\[CQ:/.test(raw)) return raw;
  const stripped = decodeHtmlEntities(raw
    .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .trim());
  return stripped || '[消息]';
}

function usableMediaFile(file) {
  const s = String(file ?? '').trim();
  return /^(?:https?:\/\/|base64:\/\/|file:\/\/|\/)/.test(s) ? s : '';
}

function textSegment(text) {
  return { type: 'text', data: { text: String(text ?? '') } };
}

/** 建立 message_id / real_id / message_seq / real_seq → 事件 的索引，供 reply 引用查原消息。 */
function buildQuoteIndex(events) {
  const map = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    for (const key of [event?.message_id, event?.real_id, event?.message_seq, event?.real_seq]) {
      const k = String(key ?? '').trim();
      // id 可能是负数；空值/0 不登记，避免串号。
      if (!k || k === '0' || map.has(k)) continue;
      map.set(k, event);
    }
  }
  return map;
}

function quoteSegments(target, { media, nameMap, quoteIndex, depth }) {
  const sender = target?.sender && typeof target.sender === 'object' ? target.sender : {};
  const nick = String(sender.card || sender.nickname || target?.user_id || '未知');
  const uin = Number(target?.user_id) || 0;
  const quoted = buildForwardContent(target, { media, nameMap, quoteIndex, depth });
  const segments = Array.isArray(quoted) ? quoted : (quoted ? [textSegment(quoted)] : []);
  return [
    textSegment(`【引用 ${nick}${uin ? `(${uin})` : ''}: `),
    ...segments,
    textSegment('】\n')
  ];
}

/**
 * 把一条消息事件转成合并转发节点可用的 content。
 * 文本/图片/表情/视频保留原段；语音/文件/聊天记录降级成占位文本，
 * 避免单个不支持的段导致整条转发失败。
 */
export function buildForwardContent(event, { media = true, nameMap = null, quoteIndex = null, depth = 0 } = {}) {
  if (!media) {
    const text = messageEventToText(event, { nameMap, quoteIndex, depth });
    return text ? [textSegment(text)] : '';
  }
  const segments = Array.isArray(event?.message) ? event.message : null;
  if (!segments || !segments.length) return messageEventToText(event, { nameMap, quoteIndex, depth });
  const out = [];
  for (const seg of segments) {
    const type = String(seg?.type ?? '');
    const d = seg?.data && typeof seg.data === 'object' ? seg.data : {};
    if (type === 'reply') {
      const id = String(d.id ?? '').trim();
      const target = quoteIndex && id ? quoteIndex.get(id) : null;
      if (depth === 0 && target && target !== event) {
        out.push(...quoteSegments(target, { media, nameMap, quoteIndex, depth: 1 }));
      } else {
        out.push(textSegment('[引用] '));
      }
      continue;
    }
    if (type === 'at') {
      const name = String(d.name || '').trim();
      const qq = String(d.qq || '').trim();
      const mapped = qq && nameMap ? String(nameMap[qq] || '').trim() : '';
      out.push(textSegment(name ? `@${name}` : mapped ? `@${mapped}` : qq === 'all' ? '@全体成员' : qq ? `@${qq}` : '@某人'));
      continue;
    }
    if (type === 'text') {
      const text = String(d.text ?? '');
      if (text) out.push(textSegment(text));
      continue;
    }
    if (type === 'face') {
      const id = Number(d.id ?? d.faceId);
      if (Number.isInteger(id) && id >= 0) out.push({ type: 'face', data: { id: String(id) } });
      else out.push(textSegment('[表情]'));
      continue;
    }
    if (type === 'image') {
      // 历史图片的 file 通常是 md5 文件名，真正可用的是签名 url。
      // sub_type=1 / summary=[动画表情] 要带上，转发后表情包才不会变成普通图片。
      const url = String(d.url || '').trim();
      const file = usableMediaFile(d.file);
      if (url || file) {
        const subType = Number(d.sub_type ?? d.subType);
        const summary = d.summary ? String(d.summary) : '';
        out.push({
          type: 'image',
          data: {
            ...(file ? { file } : {}),
            ...(url ? { url } : {}),
            ...(Number.isFinite(subType) ? { sub_type: subType } : {}),
            ...(summary ? { summary } : {})
          }
        });
      } else {
        out.push(textSegment('[图片]'));
      }
      continue;
    }
    if (type === 'mface') {
      // 表情包：有 url 就按动画表情图片转；没有就保留占位，避免 32 位 emojiId 校验失败。
      const url = String(d.url || '').trim();
      const file = usableMediaFile(d.file);
      if (url || file) {
        out.push({
          type: 'image',
          data: {
            ...(file ? { file } : {}),
            ...(url ? { url } : {}),
            sub_type: 1,
            summary: String(d.summary || d.text || '[动画表情]')
          }
        });
      } else {
        out.push(textSegment('[表情包]'));
      }
      continue;
    }
    if (type === 'video') {
      const url = String(d.url || '').trim();
      const file = usableMediaFile(d.file);
      if (url || file) out.push({ type: 'video', data: { ...(file ? { file } : {}), ...(url ? { url } : {}) } });
      else out.push(textSegment('[视频]'));
      continue;
    }
    // record / file / forward / 其他：用可读占位文本，保证整条转发不失败。
    const placeholder = messageEventToText({ message: [seg] }, { nameMap, quoteIndex, depth });
    if (placeholder) out.push(textSegment(placeholder));
  }
  return out.length ? out : messageEventToText(event);
}

/**
 * 构造合并转发节点。
 * selfUin 用于识别机器人自己发的消息；selfName 是机器人昵称。
 */
export function buildForwardNodes(events, { selfUin = 0, selfName = '', media = true, nameMap = null, quoteEvents = [] } = {}) {
  const nodes = [];
  // 引用目标可能不在本次拉取的历史里；调用方可用 get_msg 补进来。
  const quoteIndex = buildQuoteIndex([
    ...(Array.isArray(events) ? events : []),
    ...(Array.isArray(quoteEvents) ? quoteEvents : [])
  ]);
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const sender = event.sender && typeof event.sender === 'object' ? event.sender : {};
    let uin = Math.max(0, Number(event.user_id ?? sender.user_id) || 0);
    const isSelf = uin > 0 && Number(selfUin) > 0 && uin === Number(selfUin);
    if (!uin && Number(selfUin) > 0) uin = Number(selfUin);
    const nickname = String(
      sender.card || sender.nickname || (isSelf ? (selfName || '我') : '') || uin || '未知'
    );
    const content = buildForwardContent(event, { media, nameMap, quoteIndex });
    if (!content || (Array.isArray(content) && !content.length)) continue;
    nodes.push({
      type: 'node',
      data: {
        user_id: uin,
        nickname,
        content,
        time: Math.max(0, Math.round(Number(event.time) || 0)) || Math.floor(Date.now() / 1000)
      }
    });
  }
  return nodes;
}
