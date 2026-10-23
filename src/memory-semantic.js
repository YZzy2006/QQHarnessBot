// 长期记忆的语义索引与召回。
//
// 设计约束（与 bridge.js 的集成约定）：
// - 向量落盘到 state/memory-vectors.json，键为 "<kind>:<sessionKey>:<id>"。
//   会话 key 必须进 id：social-v2 是「每个 QQ 会话一份记忆」，不能把 A 群的印象召回给 B 群。
// - 只有记忆写入/编辑时才调用 embedding；唤醒查询走 5 分钟缓存，且 3 秒硬超时。
// - 任何失败都返回 null / 不抛出，由调用方回退到原来的按时间注入逻辑。
// - 不新增 npm 依赖，只用 Node 22 内置 fetch。
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(path.resolve(__dirname, '..'), 'state');
const VECTOR_FILE = path.join(STATE_DIR, 'memory-vectors.json');
const USAGE_FILE = path.join(STATE_DIR, 'embedding-usage.jsonl');

const KINDS = ['activeTopic', 'pendingThought', 'memberImpression'];
const DEFAULT_MODEL = 'text-embedding-v4';
const DEFAULT_DIMENSIONS = 1024;
const QUERY_CACHE_MS = 5 * 60 * 1000;
const QUERY_FAIL_CACHE_MS = 60 * 1000;
const MAX_VECTORS = 5000;
const MAX_QUERY_CHARS = 1500;
const BACKFILL_RETRY_MS = 10 * 60 * 1000;
const BACKFILL_BATCH = 8;

let logger = (...args) => console.log('[memory-vec]', ...args);
let loaded = false;
let loadPromise = null;
let loadCorrupt = false;
let saveTimer = null;
let saveChain = Promise.resolve();
let dirty = false;
let usageChain = Promise.resolve();

// key -> { text, vec: Float32Array, norm, at, kind, sessionKey, id }
const vectors = new Map();
const queryCache = new Map();
const queryFailCache = new Map();
const queryInFlight = new Map();
const backfillAt = new Map();
const backfillRunning = new Set();

export function setLogger(fn) {
  if (typeof fn === 'function') logger = fn;
}

function log(...args) {
  try {
    logger('[memory-vec]', ...args);
  } catch {
    // 日志失败不能影响召回。
  }
}

function normalizeText(value, maxChars = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function hashRef(kind, ref) {
  return crypto.createHash('sha1').update(`${kind}\u0000${String(ref ?? '')}`).digest('hex').slice(0, 20);
}

function vectorKey(sessionKey, kind, ref) {
  return `${kind}:${sessionKey}:${hashRef(kind, ref)}`;
}

function parseVectorKey(key) {
  const first = String(key).indexOf(':');
  if (first <= 0) return null;
  const kind = String(key).slice(0, first);
  if (!KINDS.includes(kind)) return null;
  const rest = String(key).slice(first + 1);
  const last = rest.lastIndexOf(':');
  if (last <= 0) return null;
  const sessionKey = rest.slice(0, last);
  if (!/^(group|private):\d+$/.test(sessionKey)) return null;
  return { kind, sessionKey, id: rest.slice(last + 1) };
}

// 记忆内容的 embedding 文本。必须与 appendMemoryV2 写入的内容保持一致；
// interactionCount / lastSeenAt 这类时间戳刻意不进 embedding，避免每互动一次就重算。
export function memoryEmbeddingText(kind, ref, item) {
  if (kind === 'activeTopic') {
    const text = normalizeText(item?.text ?? ref, 300);
    const question = normalizeText(item?.pendingQuestion, 200);
    if (!text) return '';
    return question ? `${text}；待追问：${question}` : text;
  }
  if (kind === 'pendingThought') {
    const text = normalizeText(item?.text ?? ref, 300);
    const motivation = normalizeText(item?.motivation, 100);
    if (!text) return '';
    return motivation ? `${text}（${motivation}）` : text;
  }
  if (kind === 'memberImpression') {
    const name = normalizeText(ref, 100);
    if (!name) return '';
    const traits = Array.isArray(item?.traits)
      ? item.traits.map((t) => normalizeText(t, 50)).filter(Boolean).slice(0, 20)
      : [];
    return `${name}：${traits.length ? traits.join('、') : '暂无记录'}`;
  }
  return '';
}

export function buildMemoryItems(sessionKey, memories = {}) {
  const byKey = new Map();
  const add = (kind, ref, item) => {
    const text = memoryEmbeddingText(kind, ref, item);
    if (!text) return;
    const key = vectorKey(sessionKey, kind, ref);
    if (byKey.has(key)) return;
    byKey.set(key, { kind, ref: String(ref), item, key, text });
  };
  for (const t of Array.isArray(memories.activeTopics) ? memories.activeTopics : []) {
    if (t && t.text) add('activeTopic', String(t.text), t);
  }
  for (const t of Array.isArray(memories.pendingThoughts) ? memories.pendingThoughts : []) {
    if (!t || !t.text) continue;
    if (t.expiresAt && Date.now() >= Number(t.expiresAt)) continue; // 过期想法不参与召回
    add('pendingThought', String(t.text), t);
  }
  const impressions = memories.memberImpressions && typeof memories.memberImpressions === 'object'
    ? memories.memberImpressions : {};
  for (const [name, item] of Object.entries(impressions)) {
    if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    add('memberImpression', name, item);
  }
  return [...byKey.values()];
}

function normOf(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

function cosine(a, normA, b, normB) {
  if (!normA || !normB || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}

function getConfig() {
  const model = String(process.env.BAILIAN_EMBEDDING_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const rawDims = Number(process.env.BAILIAN_EMBEDDING_DIMENSIONS);
  const dimensions = Number.isSafeInteger(rawDims) && rawDims > 0 ? rawDims : DEFAULT_DIMENSIONS;
  const url = String(process.env.BAILIAN_EMBEDDING_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings').trim();
  const key = String(process.env.BAILIAN_EMBEDDING_KEY || process.env.BAILIAN_API_KEY || '').trim();
  return { model, dimensions, url, key };
}

function recordUsage(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
  usageChain = usageChain
    .then(() => fsp.appendFile(USAGE_FILE, line, { encoding: 'utf8', mode: 0o600 }))
    .catch((error) => log('写 embedding-usage.jsonl 失败:', error?.message ?? error));
  return usageChain;
}

async function embedTexts(texts, { purpose = 'index', timeoutMs = 10000 } = {}) {
  const cfg = getConfig();
  if (!cfg.key) throw new Error('BAILIAN_API_KEY / BAILIAN_EMBEDDING_KEY 未配置');
  if (!Array.isArray(texts) || !texts.length) throw new Error('embedding 输入为空');
  if (!cfg.url) throw new Error('embedding URL 为空');
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 3000));
  try {
    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.model,
        input: texts.length === 1 ? texts[0] : texts,
        dimensions: cfg.dimensions,
        encoding_format: 'float'
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`embedding 响应不是 JSON（HTTP ${response.status}）`);
    }
    if (!response.ok || data?.error) {
      const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
      throw new Error(`embedding 接口失败：${String(message).slice(0, 200)}`);
    }
    const rows = Array.isArray(data?.data) ? [...data.data] : [];
    if (rows.length !== texts.length) {
      throw new Error(`embedding 返回条数不符：期望 ${texts.length}，实际 ${rows.length}`);
    }
    rows.sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
    const out = rows.map((row) => {
      const arr = Array.isArray(row?.embedding) ? row.embedding : null;
      if (!arr || !arr.length || !arr.every((n) => Number.isFinite(Number(n)))) {
        throw new Error('embedding 返回了非法向量');
      }
      return Float32Array.from(arr, (n) => Number(n));
    });
    const tokens = Number(data?.usage?.total_tokens);
    void recordUsage({
      ok: true,
      purpose,
      model: cfg.model,
      dimensions: out[0]?.length ?? cfg.dimensions,
      texts: texts.length,
      tokens: Number.isFinite(tokens) ? tokens : null,
      ms: Date.now() - started
    });
    return out;
  } catch (error) {
    const isAbort = error?.name === 'AbortError';
    const message = isAbort ? `embedding 超时（${timeoutMs}ms）` : String(error?.message ?? error);
    void recordUsage({
      ok: false,
      purpose,
      model: cfg.model,
      dimensions: cfg.dimensions,
      texts: texts.length,
      tokens: null,
      ms: Date.now() - started,
      error: message.slice(0, 300)
    });
    if (isAbort) throw new Error(message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function loadVectors() {
  let raw;
  try {
    raw = await fsp.readFile(VECTOR_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      log('向量文件不存在，从空索引开始（已有记忆会在首次召回时后台补建）');
      return;
    }
    log('读取向量文件失败，从空索引开始:', error?.message ?? error);
    loadCorrupt = true;
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    loadCorrupt = true;
    log('向量文件损坏，跳过并按空索引重建:', error?.message ?? error);
    try {
      await fsp.rename(VECTOR_FILE, `${VECTOR_FILE}.corrupt-${Date.now()}`);
      log('已把损坏的向量文件改名备份，原文件可人工检查');
    } catch (renameError) {
      log('损坏向量文件改名失败（忽略）:', renameError?.message ?? renameError);
    }
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    loadCorrupt = true;
    log('向量文件结构不是对象，跳过并按空索引重建');
    return;
  }
  const entries = [];
  let invalid = 0;
  for (const [key, value] of Object.entries(data)) {
    const parsed = parseVectorKey(key);
    if (!parsed || !value || typeof value !== 'object') { invalid++; continue; }
    if (!Array.isArray(value.vec) || !value.vec.length) { invalid++; continue; }
    const vec = new Float32Array(value.vec.length);
    let ok = true;
    for (let i = 0; i < value.vec.length; i++) {
      const n = Number(value.vec[i]);
      if (!Number.isFinite(n)) { ok = false; break; }
      vec[i] = n;
    }
    if (!ok) { invalid++; continue; }
    entries.push([key, {
      text: String(value.text ?? ''),
      vec,
      norm: normOf(vec),
      at: Number(value.at) || 0,
      ...parsed
    }]);
  }
  // 防止异常大的文件把桥接进程撑爆：只载入最近的 MAX_VECTORS 条。
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const kept = entries.slice(0, MAX_VECTORS);
  for (const [key, value] of kept) vectors.set(key, value);
  if (entries.length > MAX_VECTORS) {
    log(`向量文件共 ${entries.length} 条，超过内存上限 ${MAX_VECTORS}，只载入最近 ${MAX_VECTORS} 条`);
  }
  if (invalid) log(`向量文件中有 ${invalid} 条无效记录，已跳过`);
  log(`启动加载完成：${vectors.size} 条向量，维度 ${kept[0]?.[1]?.vec?.length ?? '未知'}`);
}

function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = (async () => {
      await fsp.mkdir(STATE_DIR, { recursive: true });
      await loadVectors();
      loaded = true;
    })().catch((error) => {
      loaded = true;
      loadCorrupt = true;
      log('加载向量索引异常，按空索引继续:', error?.message ?? error);
    });
  }
  return loadPromise;
}

export function warmUp() {
  return ensureLoaded();
}

function serializeVectors() {
  const output = {};
  for (const [key, value] of vectors) {
    output[key] = { text: value.text, vec: Array.from(value.vec), at: value.at };
  }
  return JSON.stringify(output);
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushVectors().catch((error) => log('保存向量文件失败:', error?.message ?? error));
  }, 250);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

export async function flushVectors() {
  await ensureLoaded();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) {
    await saveChain.catch(() => {});
    return;
  }
  dirty = false;
  const payload = serializeVectors();
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(STATE_DIR, { recursive: true });
      const tmp = `${VECTOR_FILE}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, VECTOR_FILE);
    })
    .catch((error) => {
      dirty = true;
      throw error;
    });
  await saveChain;
}

function pruneQueryCaches(now) {
  for (const [key, entry] of queryCache) {
    if (now - entry.at > QUERY_CACHE_MS) queryCache.delete(key);
  }
  for (const [key, at] of queryFailCache) {
    if (now - at > QUERY_FAIL_CACHE_MS) queryFailCache.delete(key);
  }
  while (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value);
}

async function embedQuery(queryText, timeoutMs) {
  const query = normalizeText(queryText, MAX_QUERY_CHARS);
  if (!query) throw new Error('查询文本为空');
  const now = Date.now();
  pruneQueryCaches(now);
  const cached = queryCache.get(query);
  if (cached && now - cached.at <= QUERY_CACHE_MS) return { ...cached, cached: true };
  const failedAt = queryFailCache.get(query);
  if (failedAt && now - failedAt <= QUERY_FAIL_CACHE_MS) {
    throw new Error('查询 embedding 最近失败过，直接回退（60 秒内不重试）');
  }
  if (queryInFlight.has(query)) return queryInFlight.get(query);
  const promise = (async () => {
    try {
      const [vec] = await embedTexts([query], { purpose: 'query', timeoutMs });
      const entry = { vec, norm: normOf(vec), at: Date.now(), cached: false };
      queryCache.set(query, entry);
      queryFailCache.delete(query);
      return entry;
    } catch (error) {
      queryFailCache.set(query, Date.now());
      throw error;
    } finally {
      queryInFlight.delete(query);
    }
  })();
  queryInFlight.set(query, promise);
  return promise;
}

// 写入/更新一条记忆向量。失败只记日志，不抛出。
export async function indexMemory({ sessionKey, kind, ref, item }) {
  try {
    if (!sessionKey || !KINDS.includes(kind)) return false;
    await ensureLoaded();
    const text = memoryEmbeddingText(kind, ref, item);
    if (!text) {
      log(`跳过空文本记忆 ${kind}`);
      return false;
    }
    const key = vectorKey(sessionKey, kind, ref);
    const existing = vectors.get(key);
    const cfg = getConfig();
    if (existing && existing.text === text && existing.vec.length === cfg.dimensions) {
      return true; // 内容没变，不花 token
    }
    const [vec] = await embedTexts([text], { purpose: 'index', timeoutMs: 10000 });
    vectors.set(key, {
      text,
      vec,
      norm: normOf(vec),
      at: Date.now(),
      kind,
      sessionKey,
      id: hashRef(kind, ref)
    });
    scheduleSave();
    log(`索引 ${kind} ${String(ref).slice(0, 20)} dims=${vec.length}`);
    return true;
  } catch (error) {
    log(`索引失败 ${kind}:`, error?.message ?? error);
    return false;
  }
}

// 删除若干条记忆的向量（记忆被删/编辑/过期/被挤出上限时调用）。
export async function removeMemoryRefs(sessionKey, refs) {
  try {
    if (!sessionKey || !Array.isArray(refs) || !refs.length) return 0;
    await ensureLoaded();
    let removed = 0;
    for (const entry of refs) {
      if (!entry || !KINDS.includes(entry.kind) || !entry.ref) continue;
      const key = vectorKey(sessionKey, entry.kind, entry.ref);
      if (vectors.delete(key)) removed++;
    }
    if (removed) {
      scheduleSave();
      log(`清理 ${sessionKey} 的 ${removed} 条向量`);
    }
    return removed;
  } catch (error) {
    log('清理向量失败:', error?.message ?? error);
    return 0;
  }
}

export async function clearMemoryVectors(sessionKey, kind = '') {
  try {
    if (!sessionKey) return 0;
    await ensureLoaded();
    let removed = 0;
    for (const [key, entry] of vectors) {
      if (entry.sessionKey !== sessionKey) continue;
      if (kind && entry.kind !== kind) continue;
      vectors.delete(key);
      removed++;
    }
    if (removed) {
      scheduleSave();
      log(`清空 ${sessionKey}${kind ? `（${kind}）` : ''} 的 ${removed} 条向量`);
    }
    return removed;
  } catch (error) {
    log('清空向量失败:', error?.message ?? error);
    return 0;
  }
}

export async function clearAllMemoryVectors() {
  try {
    await ensureLoaded();
    const count = vectors.size;
    vectors.clear();
    if (count) {
      scheduleSave();
      log(`清空全部 ${count} 条向量`);
    }
    return count;
  } catch (error) {
    log('清空全部向量失败:', error?.message ?? error);
    return 0;
  }
}

function pruneSessionVectors(sessionKey, validKeys) {
  let removed = 0;
  for (const [key, entry] of vectors) {
    if (entry.sessionKey !== sessionKey) continue;
    if (validKeys.has(key)) continue;
    vectors.delete(key);
    removed++;
  }
  if (removed) {
    scheduleSave();
    log(`清理 ${sessionKey} 的 ${removed} 条失效/过期向量`);
  }
  return removed;
}

function scheduleBackfill(sessionKey, missing) {
  if (!missing.length || backfillRunning.has(sessionKey)) return;
  const now = Date.now();
  if (now - (backfillAt.get(sessionKey) || 0) < BACKFILL_RETRY_MS) return;
  backfillAt.set(sessionKey, now);
  backfillRunning.add(sessionKey);
  void (async () => {
    log(`后台补建 ${sessionKey} 的 ${missing.length} 条记忆向量`);
    let ok = 0;
    let failed = 0;
    const dims = getConfig().dimensions;
    for (let i = 0; i < missing.length && i < 200; i += BACKFILL_BATCH) {
      const batch = missing.slice(i, i + BACKFILL_BATCH).filter((item) => {
        const existing = vectors.get(item.key);
        return !existing || existing.vec.length !== dims;
      });
      if (!batch.length) continue;
      try {
        const rows = await embedTexts(batch.map((item) => item.text), { purpose: 'backfill', timeoutMs: 15000 });
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          const vec = rows[j];
          if (!vec) continue;
          vectors.set(item.key, {
            text: item.text,
            vec,
            norm: normOf(vec),
            at: Date.now(),
            kind: item.kind,
            sessionKey,
            id: hashRef(item.kind, item.ref)
          });
          ok++;
        }
        scheduleSave();
      } catch (error) {
        failed += batch.length;
        log('后台补建批次失败:', error?.message ?? error);
        break;
      }
    }
    log(`后台补建结束 ${sessionKey}: 成功 ${ok}，失败 ${failed}`);
  })()
    .catch((error) => log('后台补建异常:', error?.message ?? error))
    .finally(() => backfillRunning.delete(sessionKey));
}

// 语义召回。成功返回 [{kind, ref, score, key}]，任何失败返回 null。
export async function recallMemory({
  sessionKey,
  queryText,
  memories,
  topK = 12,
  minPerKind = 2,
  timeoutMs = 3000
} = {}) {
  try {
    if (!sessionKey) return null;
    await ensureLoaded();
    const items = buildMemoryItems(sessionKey, memories || {});
    const validKeys = new Set(items.map((item) => item.key));
    pruneSessionVectors(sessionKey, validKeys);
    if (!items.length) {
      log('当前会话没有记忆，跳过语义召回');
      return null;
    }
    // 维度不一致也当作缺失：模型/维度配置改过之后，旧向量不能参与余弦计算，
    // 否则会永远回退且不会触发补建。
    const configuredDims = getConfig().dimensions;
    const missing = items.filter((item) => {
      const entry = vectors.get(item.key);
      return !entry || entry.vec.length !== configuredDims;
    });
    if (missing.length) scheduleBackfill(sessionKey, missing);
    const query = normalizeText(queryText, MAX_QUERY_CHARS);
    if (!query) return null;

    let queryEntry;
    try {
      queryEntry = await embedQuery(query, Math.max(1, Number(timeoutMs) || 3000));
    } catch (error) {
      log('查询 embedding 失败，回退按时间注入:', error?.message ?? error);
      return null;
    }

    const scored = [];
    for (const item of items) {
      const entry = vectors.get(item.key);
      if (!entry || entry.vec.length !== queryEntry.vec.length) continue;
      const score = cosine(queryEntry.vec, queryEntry.norm, entry.vec, entry.norm);
      if (!Number.isFinite(score)) continue;
      scored.push({ kind: item.kind, ref: item.ref, key: item.key, score, text: item.text });
    }
    if (!scored.length) {
      log('没有可用向量（可能正在后台补建），回退按时间注入');
      return null;
    }
    scored.sort((a, b) => b.score - a.score);

    const byKind = new Map();
    for (const entry of scored) {
      if (!byKind.has(entry.kind)) byKind.set(entry.kind, []);
      byKind.get(entry.kind).push(entry);
    }
    const selected = [];
    const used = new Set();
    for (const kind of KINDS) {
      const list = byKind.get(kind) || [];
      const take = Math.min(minPerKind, list.length);
      for (let i = 0; i < take; i++) {
        selected.push(list[i]);
        used.add(list[i].key);
      }
    }
    const target = Math.max(topK, selected.length);
    for (const entry of scored) {
      if (selected.length >= target) break;
      if (used.has(entry.key)) continue;
      selected.push(entry);
      used.add(entry.key);
    }
    selected.sort((a, b) => b.score - a.score);
    const picked = selected.slice(0, target);
    const summary = picked
      .map((entry) => `${entry.kind}/${String(entry.ref).slice(0, 14)}=${entry.score.toFixed(3)}`)
      .join(' | ');
    log(`召回 ${sessionKey} query="${query.slice(0, 30)}" 候选=${scored.length} 入选=${picked.length}${queryEntry.cached ? '（查询缓存命中）' : ''}：${summary}`);
    return picked.map(({ kind, ref, score, key }) => ({ kind, ref, score, key }));
  } catch (error) {
    log('语义召回异常，回退按时间注入:', error?.message ?? error);
    return null;
  }
}

export function getMemoryVectorStatus() {
  return {
    loaded,
    count: vectors.size,
    corrupt: loadCorrupt,
    file: VECTOR_FILE
  };
}
