// QQ 原生表情（小黄脸/超级表情）映射与出站消息组装。
//
// 为什么用原生表情：收藏表情是图片，发多了更容易被风控；小黄脸是 QQ 自带 face 段，
// 体积小、语义明确，和真人聊天更像。这里只做纯函数，发不发、发几个由 bridge/模型决定。
//
// 全量名称来自 `src/qq-face-data.js`（由 SnowLuma `fetch_sys_faces` 的 q_sid 生成，285 个数字 id）。
// emoji 表情包的 q_sid 是 emoji 字符，实测 OneBot 报 retcode 1400，所以不收录。
// 常用 id：狗头/doge/狗头保命=277、傲娇=179、捂脸=264、笑哭=182、吃瓜=271、赞=76、
// 白眼=22、委屈=106、菜狗/菜汪=317、崇拜=318（后两个超级表情，带 large:true）。
// 注意：QQ 目录里 179 的内部名叫 doge，但图案是“傲娇”脸；日常说的 doge/狗头保命
// 指的是 277 狗头，不是狗叫。发送与释义都以 277 为狗头，179 只用于明确的傲娇。
import { QQ_FACE_DATA } from './qq-face-data.js';

const face = (id) => Object.freeze({ id: String(id) });
const largeFace = (id) => Object.freeze({ id: String(id), large: true });

function normalizeEntry(value) {
  if (typeof value === 'string') return face(value);
  const id = String(value?.id ?? '');
  return value?.large ? largeFace(id) : face(id);
}

// 手工别名：补目录里没有/叫法不同的常用名。
const ALIASES = Object.freeze({
  '狗头': '277',
  // doge 在 QQ 目录里的内部名是 179（傲娇脸），但日常语境说的 doge 就是狗头保命，
  // 按用户实际用法指向 277；要发傲娇脸请显式写 [傲娇]。
  'doge': '277',
  '狗头保命': '277',
  '傲娇': '179',
  'ww': '277',
  'wwww': '277',
  '汪汪': '277',
  '菜狗': { id: '317', large: true },
  '菜汪': { id: '317', large: true },
  '崇拜': { id: '318', large: true },
  '抱抱': '49',
  '亲亲': '109',
  '点赞': '201',
  '贴贴': { id: '350', large: true },
  '牛': '299',
  '厉害': '76',
  '佩服': '76',
  '强': { id: '349', large: true }
});

const merged = { ...QQ_FACE_DATA, ...ALIASES };

/** 标记名（小写）→ face 段数据。中英文大小写都登记，模型写 [Doge] 也能认。 */
export const QQ_FACE_MAP = Object.freeze(
  Object.entries(merged).reduce((acc, [name, value]) => {
    const entry = normalizeEntry(value);
    acc[name] = entry;
    const lower = name.toLowerCase();
    if (!acc[lower]) acc[lower] = entry;
    return acc;
  }, Object.create(null))
);

// 反向映射优先用最常用的叫法，避免 179 被显示成别的别名。
const PREFERRED_NAMES = Object.freeze({
  '179': '傲娇',
  '264': '捂脸',
  '182': '笑哭',
  '271': '吃瓜',
  '76': '赞',
  '22': '白眼',
  '106': '委屈',
  // 277 是狗头；「汪汪/ww」只是同一张脸的别名，展示时统一叫狗头，避免模型误读成狗叫。
  '277': '狗头',
  '317': '菜狗',
  '318': '崇拜',
  '49': '拥抱'
});

/** face id → 可读名称（供收到的表情转文字用）。 */
export const QQ_FACE_NAMES = Object.freeze(
  Object.entries(QQ_FACE_MAP).reduce((acc, [name, entry]) => {
    if (!acc[entry.id]) acc[entry.id] = name;
    return acc;
  }, Object.assign(Object.create(null), PREFERRED_NAMES))
);

/** 取某个 face id 的可读名称；未知返回空串。 */
export function faceNameOf(id) {
  const key = String(id ?? '').trim();
  return key ? (QQ_FACE_NAMES[key] || '') : '';
}

// 两张最容易混淆的脸单独写说明：入站时直接告诉模型「这是什么、别理解成什么」。
// OneBot 的 face.summary 常常带上游的错误命名（277 被标成「傲娇」、179 被标成「狗头」），
// 所以这里只认 id，不采信 summary。
const FACE_TEXT_NOTES = Object.freeze({
  '277': '[表情:狗头] 是玩笑/调侃/反讽用的狗头保命，常用标记 [doge]、[狗头]、[狗头保命] 都是它；不是狗叫，也不是傲娇。',
  '179': '[表情:傲娇] 是傲娇脸，QQ 目录内部名doge，发出去长这样；它不是狗头，别当成狗头保命。'
});

/**
 * 把收到的 face id 转成模型可读的说明。
 * 常用表情返回「标记 + 一句话释义」，其余返回纯标记，未知 id 返回 [表情<id>]。
 */
export function faceTextOf(id) {
  const key = String(id ?? '').trim();
  if (!key) return '';
  const note = FACE_TEXT_NOTES[key];
  if (note) return note;
  const name = faceNameOf(key);
  return name ? `[表情:${name}]` : `[表情${key}]`;
}

// 提示词/帮助里展示的常用标记（只保留映射表里真实存在的）。
const MARKER_CANDIDATES = [
  '狗头', '狗头保命', 'doge', '汪汪', 'ww', '傲娇', '菜狗', '崇拜', '捂脸', '笑哭', '吃瓜', '赞', '白眼',
  '委屈', '调皮', '可爱', '流汗', '擦汗', '拥抱', '抱拳', '偷笑', '坏笑', '心碎',
  '可怜', '挥手', '卖萌', '得意', '憨笑', '惊讶', '疑问', '再见', '收到', '亲亲',
  '比心', '打call', '晚安', '开心', '无语', '厉害', '合十', '好的', '害羞', '色',
  '流泪', '大哭', '发怒', '呲牙', '微笑', '酷', '抓狂', '吐', '傲慢', '饥饿',
  '困', '惊恐', '大兵', '奋斗', '咒骂', '嘘', '晕', '折磨', '衰', '骷髅'
];
export const QQ_FACE_MARKERS = Object.freeze(MARKER_CANDIDATES.filter((name) => QQ_FACE_MAP[name]));

const MARKER_RE = /[\[【]\s*([^\[\]【】\n]{1,12})\s*[\]】]/g;

function markerName(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^表情[:：]\s*/, '')
    .replace(/^\//, '')
    .toLowerCase();
}

/**
 * 把文本里的 [狗头] / [傲娇] / 【doge】 / [表情:捂脸] 等标记拆成 OneBot 消息段。
 * 不认识的方括号内容原样保留——它们可能是 [图片]、[CQ:...] 或普通文字。
 *
 * @param {string} text
 * @param {{escapeText?: (s:string)=>string}} [options] 每个文本段的转义函数
 * @returns {Array<{type:string,data:object}>}
 */
export function normalizeQQQuotes(value) {
  return String(value ?? '').replace(/[「『]/g, '“').replace(/[」』]/g, '”');
}

export function buildFaceSegments(text, { escapeText = (s) => s } = {}) {
  const raw = normalizeQQQuotes(text);
  const out = [];
  let last = 0;
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(raw)) !== null) {
    const entry = QQ_FACE_MAP[markerName(m[1])];
    if (!entry) continue;
    if (m.index > last) {
      out.push({ type: 'text', data: { text: escapeText(raw.slice(last, m.index)) } });
    }
    out.push({
      type: 'face',
      data: entry.large ? { id: entry.id, large: true } : { id: entry.id }
    });
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    out.push({ type: 'text', data: { text: escapeText(raw.slice(last)) } });
  }
  if (!out.length) out.push({ type: 'text', data: { text: '' } });
  return out;
}

/** 文本里是否已经有可识别的表情标记。 */
export function hasFaceMarker(text) {
  const s = String(text ?? '');
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(s)) !== null) {
    if (QQ_FACE_MAP[markerName(m[1])]) return true;
  }
  return false;
}

// 自动加表情的语境规则：只匹配比较明确的情绪词，避免严肃内容硬塞表情。
// 顺序有意义：先匹配更具体的情绪，再匹配泛化的“赞/厉害”。
export const AUTO_RULES = Object.freeze([
  { re: /(哈哈|笑死|笑哭|绷不住|太好笑|乐死|笑不活)/, marker: '笑哭' },
  { re: /(无语|服了|离谱|难绷|汗颜)/, marker: '捂脸' },
  // doge 日常就是狗头保命，先于傲娇匹配；写「傲娇」才出 179。
  { re: /(狗头|狗狗|doge)/i, marker: '狗头' },
  { re: /(傲娇)/, marker: '傲娇' },
  { re: /(逗你|开个?玩笑|认真的吗|滑稽)/, marker: '狗头' },
  { re: /(吃瓜|围观|看戏)/, marker: '吃瓜' },
  { re: /(委屈|呜呜|想哭|难过|伤心)/, marker: '委屈' },
  { re: /(白眼|切~|哼|不屑)/, marker: '白眼' },
  { re: /(可爱|贴贴|捏捏)/, marker: '可爱' },
  { re: /(抱抱|抱一下|抱紧)/, marker: '拥抱' },
  { re: /(谢谢|感谢|多谢)/, marker: '抱拳' },
  { re: /(再见|拜拜|晚安|走了)/, marker: '挥手' },
  { re: /(害羞|不好意思|脸红)/, marker: '害羞' },
  { re: /(震惊|卧槽|啊这|不会吧)/, marker: '惊讶' },
  // 自动补表情只用经典小黄脸，避免自动冒出菜狗/崇拜这类大图；超级表情只在模型显式写标记时发送。
  { re: /(崇拜|膜拜|大神|佩服)/, marker: '赞' },
  { re: /(摸头|摸摸)/, marker: '可爱' },
  { re: /(打call|加油)/i, marker: '赞' },
  { re: /(亲亲|啵啵)/, marker: '亲亲' },
  { re: /(牛|厉害|不错|可以啊|好耶|赞|太强)/, marker: '赞' }
]);

// 严肃/敏感内容不自动加表情。
const SERIOUS_RE = /(报警|密码|验证码|转账|身份证|医院|自杀|去世|死亡|急救|举报|封号|律师|合同|工资|欠款)/;

/**
 * 按语境挑一个自动表情标记。
 *
 * 频率是刻意的：短句（≤20 字）按 base 概率，中等长度减半，长消息（>maxChars）不自动加。
 * 这样“一句话偶尔一两个、长段话只有一个或没有”由长度和概率共同保证；
 * 模型自己写多个标记时不受这个限制。
 *
 * @param {string} text
 * @param {{probability?: number, maxChars?: number, random?: ()=>number}} [options]
 * @returns {string} 标记名；不满足条件返回空串
 */
export function pickAutoFace(text, { probability = 0.12, maxChars = 80, random = Math.random } = {}) {
  const s = String(text ?? '').trim();
  if (!s || s.length > Math.max(1, Number(maxChars) || 80)) return '';
  if (hasFaceMarker(s)) return '';
  if (SERIOUS_RE.test(s)) return '';
  const rawProbability = Number(probability);
  const base = Number.isFinite(rawProbability) ? Math.max(0, Math.min(1, rawProbability)) : 0;
  const p = s.length <= 20 ? base : base * 0.5;
  if (p <= 0 || random() >= p) return '';
  for (const rule of AUTO_RULES) {
    if (!QQ_FACE_MAP[rule.marker]) continue;
    if (rule.re.test(s)) return rule.marker;
  }
  return '';
}

/** 在文本末尾追加一个自动表情标记（没有合适表情时原样返回）。 */
export function appendAutoFace(text, options = {}) {
  const marker = pickAutoFace(text, options);
  if (!marker) return String(text ?? '');
  return `${String(text ?? '').trimEnd()} [${marker}]`;
}
