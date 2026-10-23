// 入站消息链接预览：抓网页 <title> + 正文前 200 字，包成不可信内容块。
//
// 设计约束：
// - 抓取必须走 safe-fetch.js 的 safeFetch（SSRF 防护、限大小、手动跟随重定向）。
// - 网页内容必须走 untrusted.js 的 sanitizeUntrusted + wrapUntrusted，只当资料。
// - 每条消息最多 2 个 URL；同一会话每分钟最多抓 5 次；同一 URL 10 分钟内不重复抓。
// - 单个 URL 硬超时 6 秒（两个 URL 并发抓，总等待不超过约 6 秒）。
// - 任何失败只 log，不抛给调用方 —— 预览失败绝不能让消息丢失。
import { safeFetch } from './safe-fetch.js';
import { sanitizeUntrusted, wrapUntrusted } from './untrusted.js';

const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_PER_WINDOW = 5;
const MAX_URLS_PER_MESSAGE = 2;
const MAX_URL_LENGTH = 2048;
const TITLE_MAX_CHARS = 120;
const SUMMARY_MAX_CHARS = 200;
const CACHE_MAX_ENTRIES = 200;
const BLOCK_MAX_CHARS = 2400;
const DISPLAY_URL_MAX_CHARS = 300;
// 中文消息里 URL 后面常常直接跟正文（没有空格）。遇到空格/引号/CJK/全角标点就截断，
// 否则会把「https://a.com好看」整串当成 URL，抓取必然失败。
const URL_RE = /https?:\/\/[^\s<>"'`　-〿一-鿿＀-￯]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?'"\])}）】」』》〉…]+$/u;

// url -> { expiresAt: number, block: string }
// block 为空串表示「抓过但没抓到可用内容」，同样缓存，避免坏链接被反复请求。
const cache = new Map();
// 会话 key -> 最近一分钟内的抓取时间戳
const rateWindows = new Map();

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeCodePoint(code) {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : '';
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&middot;/gi, '·');
}

/** 从一段文本里提取 http(s) URL：去重、限长、最多 MAX_URLS_PER_MESSAGE 个。 */
// 2026-10-17：裸域名支持。实测用户更常发 `rainmeet.cn` 这种不带协议头的地址，
// 而原实现只认 http(s)://，导致自动预览一次都没触发过（线上 1569 行日志零命中）。
// TLD 白名单 + 前后边界，避免把 `v1.2.3`、`file.txt`、`3.5` 误判成网站。
const BARE_TLDS = new Set([
  'cn','com','net','org','io','co','me','ai','dev','app','xyz','top','info','tv','cc','so','gg',
  'link','site','online','tech','blog','wiki','gov','edu','hk','tw','jp','us','uk','de','fr','ru',
]);
const BARE_DOMAIN_RE = /(?:^|[\s，。！？、；：""''（）()\[\]<>《》,.!?;:"'])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=$|[\s，。！？、；：""''（）()\[\]<>《》,.!?;:"'])/gi;

export function extractPreviewUrls(text) {
  const urls = [];
  const seen = new Set();
  for (const match of String(text ?? '').matchAll(URL_RE)) {
    const raw = match[0].replace(TRAILING_PUNCT_RE, '');
    if (!raw || raw.length > MAX_URL_LENGTH) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    // safeFetch 也会拒绝带凭据的 URL；这里提前过滤，避免无意义的日志。
    if (parsed.username || parsed.password) continue;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= MAX_URLS_PER_MESSAGE) break;
  }
  // 第二遍：裸域名。先把完整 URL 全部挖掉，避免同一个域名被算两次。
  const withoutFull = String(text ?? '').replace(URL_RE, ' ');
  for (const match of withoutFull.matchAll(BARE_DOMAIN_RE)) {
    const host = String(match[1] ?? '').toLowerCase();
    if (!host || host.length > 200) continue;
    const tld = host.slice(host.lastIndexOf('.') + 1);
    if (!BARE_TLDS.has(tld)) continue;
    // 纯 IP 形式（1.2.3.4）的 "tld" 是数字，已被 [a-z]{2,24} 排除；这里再挡一次。
    if (!/^[a-z]{2,24}$/.test(tld)) continue;
    const normalized = `https://${host}/`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= MAX_URLS_PER_MESSAGE) break;
  }
  return urls;
}

function extractTitle(html) {
  const match = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeEntities(match[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS);
}

/**
 * 轻量正文提取：去掉不可能含正文的整块标签，块级标签转换行，再剥标签、解实体。
 * 思路与 mcp-web-search-safe.js 的 extractReadableText 一致；这里只需要前 200 字。
 */
function extractReadableText(html) {
  const raw = String(html ?? '');
  if (!raw) return '';
  return decodeEntities(raw
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    // 响应体被 safeFetch 截断时，最后一个 <script>/<style> 可能没有闭合标签，
    // 成对删除匹配不到，会把整段 JS/CSS 当正文。这里把未闭合块直接砍到结尾。
    .replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*$/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|td|th|dt|dd|header|footer|main|aside|nav)[^>]*>/gi, '\n')
    .replace(/<(br|hr)[^>]*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMetaDescription(html) {
  const raw = String(html ?? '');
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]*property=["']og:description["'][^>]*>/i,
  ];
  for (const re of patterns) {
    const match = raw.match(re);
    if (!match) continue;
    const text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, SUMMARY_MAX_CHARS);
  }
  return '';
}

function extractSummary(html, title) {
  let text = extractReadableText(html).replace(/\s+/g, ' ').trim();
  if (title && text.startsWith(title)) text = text.slice(title.length).trim();
  // 头部脚本很长、正文被 50k 截断挡在外面的站点（实测 qq.com / baidu.com），
  // 正文提取结果会为空。这时退回 meta description，至少给模型一句人话。
  if (text.length < 20) text = extractMetaDescription(html) || text;
  return text.slice(0, SUMMARY_MAX_CHARS);
}

// 粗略识别二进制/非 UTF-8 内容：safeFetch 固定按 UTF-8 解码，PDF/图片/GBK 页面
// 会变成大量 U+FFFD，直接跳过比把乱码喂给模型好。
function looksBinary(text) {
  const sample = String(text ?? '').slice(0, 2000);
  if (!sample) return false;
  let bad = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0);
    if (code === 0xfffd || code === 0) bad += 1;
  }
  return bad / sample.length > 0.1;
}

async function fetchPreviewBlock(url) {
  const result = await withTimeout(safeFetch(url), FETCH_TIMEOUT_MS, `抓取 ${url}`);
  if (!result || result.statusCode < 200 || result.statusCode >= 300) return '';
  const html = String(result.body ?? '');
  if (looksBinary(html)) return '';
  const title = extractTitle(html);
  const summary = extractSummary(html, title);
  if (!title && !summary) return '';
  const lines = [];
  if (title) lines.push(`标题：${sanitizeUntrusted(title)}`);
  if (summary) lines.push(`摘要：${sanitizeUntrusted(summary)}`);
  return wrapUntrusted('网页链接预览', lines.join('\n'));
}

function pruneCache(now) {
  for (const [url, entry] of cache) {
    if (!entry || entry.expiresAt <= now) cache.delete(url);
  }
  // 仍然超限时按插入顺序淘汰最旧的（Map 保持插入序）。
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function displayUrl(url) {
  const value = String(url ?? '');
  return value.length > DISPLAY_URL_MAX_CHARS ? `${value.slice(0, DISPLAY_URL_MAX_CHARS)}…` : value;
}

function getCached(url, now) {
  const entry = cache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(url);
    return null;
  }
  return entry;
}

function setCached(url, block, now) {
  cache.delete(url);
  cache.set(url, { expiresAt: now + CACHE_TTL_MS, block });
  pruneCache(now);
}

/** 取一个抓取名额；返回 false 表示本会话这一分钟已经抓够了。 */
function takeRateSlot(conversationKey, now) {
  const key = String(conversationKey || '');
  if (!key) return true; // 没有会话标识时不限流（测试/独立调用场景）
  const recent = (rateWindows.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_PER_WINDOW) {
    rateWindows.set(key, recent);
    return false;
  }
  recent.push(now);
  rateWindows.set(key, recent);
  // 有界：会话数很多时清掉已经过期的窗口。
  if (rateWindows.size > 500) {
    for (const [k, times] of rateWindows) {
      if (!times.some((at) => now - at < RATE_WINDOW_MS)) rateWindows.delete(k);
    }
  }
  return true;
}

/**
 * 为一条入站消息生成链接预览块。
 *
 * @param {string} text 当前消息自己的文本（不要传引用/历史消息的合并文本）
 * @param {{ conversationKey?: string, log?: (...args: any[]) => void }} options
 * @returns {Promise<string>} 可直接追加到当前消息文本后的预览块；没有 URL/全部失败时为空串
 */
export async function buildLinkPreviewBlock(text, options = {}) {
  const { conversationKey = '', log = () => {} } = options ?? {};
  const urls = extractPreviewUrls(text);
  if (!urls.length) return '';

  const now = Date.now();
  const results = await Promise.all(urls.map(async (url) => {
    const cached = getCached(url, now);
    if (cached) {
      log(`[link-preview] 缓存命中 ${url}${cached.block ? '' : '（此前抓取无可用内容）'}`);
      return cached.block ? `[链接预览 ${displayUrl(url)}]\n${cached.block}` : '';
    }
    if (!takeRateSlot(conversationKey, now)) {
      log(`[link-preview] 会话 ${conversationKey || '未知'} 每分钟抓取超过 ${RATE_LIMIT_PER_WINDOW} 次，跳过 ${url}`);
      return '';
    }
    const startedAt = Date.now();
    try {
      const block = await fetchPreviewBlock(url);
      setCached(url, block, Date.now());
      if (!block) {
        log(`[link-preview] 无可提取内容 ${url}（${Date.now() - startedAt}ms）`);
        return '';
      }
      const title = extractTitleFromBlock(block);
      log(`[link-preview] 抓取成功 ${url}（${Date.now() - startedAt}ms）${title ? `标题="${title}"` : ''}`);
      return `[链接预览 ${displayUrl(url)}]\n${block}`;
    } catch (error) {
      // 失败也写缓存：坏域名/超时链接在 10 分钟内不再重试。
      setCached(url, '', Date.now());
      log(`[link-preview] 抓取失败 ${url}（${Date.now() - startedAt}ms）：${error?.message ?? error}`);
      return '';
    }
  }));

  return results.filter(Boolean).join('\n\n').slice(0, BLOCK_MAX_CHARS);
}

// 仅用于日志：从已包装的块里取标题行，避免把整块内容打进日志。
function extractTitleFromBlock(block) {
  const match = String(block ?? '').match(/标题：([^\n]{1,80})/);
  return match ? match[1] : '';
}
