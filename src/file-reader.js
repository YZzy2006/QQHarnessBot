// QQ 文件消息 → 正文文本。
//
// 与 voice-asr.js 同样的原则：任何失败都只降级成 [文件：xxx]，绝不抛给调用方，
// 也绝不让下载/解析卡住整条消息。
//
// 安全：
// - 硬限制单文件 10MB、一条消息累计 20MB、下载 15s、解析 20s；
// - 解析在独立子进程里跑（--max-old-space-size=256），父进程只拿 stdout 的 JSON；
// - 正文先 sanitizeUntrusted，再 wrapUntrusted，才允许进上下文；
// - 临时文件写完立即删，不落盘保存。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeUntrusted, wrapUntrusted } from './untrusted.js';

export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 15000;
const PARSE_TIMEOUT_MS = 20000;
const MAX_TEXT_CHARS = 20000;
const CHILD_STDOUT_MAX = 3 * 1024 * 1024;
const CHILD_STDERR_MAX = 16 * 1024;
const PARSE_SCRIPT = fileURLToPath(new URL('./parse-file-child.js', import.meta.url));

const CACHE_TTL_MS = 5 * 60 * 1000;
const FAIL_CACHE_TTL_MS = 60 * 1000;
const RESULT_CACHE = new Map(); // key -> { at, text, bytes }
const INFLIGHT = new Map();     // key -> Promise<{ text, bytes }>

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json']);
const XLSX_EXTS = new Set(['.xlsx', '.xls']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tif', '.tiff', '.svg']);
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz']);
const BINARY_EXTS = new Set(['.exe', '.dll', '.so', '.bin', '.apk', '.msi']);

class FileTooLargeError extends Error {
  constructor(actual, maxBytes) {
    super(`文件过大 ${actual} bytes > ${maxBytes} bytes`);
    this.name = 'FileTooLargeError';
    // maxBytes 小于单文件硬限制，说明是被 20MB 总量卡住的
    this.limit = maxBytes < FILE_MAX_BYTES ? 'total' : 'single';
  }
}

export function fileDisplayName(raw) {
  const base = path.basename(String(raw ?? ''))
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || '未知文件').slice(0, 120);
}

function intOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function kindFromName(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (XLSX_EXTS.has(ext)) return 'xlsx';
  if (TEXT_EXTS.has(ext)) return 'text';
  return '';
}

function unsupportedReason(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return `图片（${ext}）不支持读取，请走视觉模型`;
  if (ARCHIVE_EXTS.has(ext)) return `压缩包（${ext}）不支持读取`;
  if (BINARY_EXTS.has(ext)) return `可执行/二进制文件（${ext}）不支持读取`;
  if (ext === '.doc') return '旧版 .doc 不支持，请转成 .docx';
  return ext ? `不支持的格式 ${ext}` : '无法从文件名判断格式';
}

function cacheKey(d, name) {
  const id = String(d?.file_id ?? d?.id ?? '').trim();
  if (id) return `id:${id}`;
  const url = String(d?.url ?? '').trim();
  if (url) return `url:${url}`;
  return `name:${name}:${intOr(d?.file_size ?? d?.size, 0)}`;
}

function extForKind(kind) {
  if (kind === 'pdf') return 'pdf';
  if (kind === 'docx') return 'docx';
  if (kind === 'xlsx') return 'xlsx';
  return 'txt';
}

function sniffKind(buf, fallback) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // zip：看中央目录/本地文件头里的路径，判断是 docx 还是 xlsx
    const head = buf.subarray(0, Math.min(buf.length, 512 * 1024)).toString('latin1');
    if (head.includes('word/document.xml')) return 'docx';
    if (head.includes('xl/workbook.xml')) return 'xlsx';
  }
  return fallback;
}

async function downloadFile(url, maxBytes) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('文件 URL 非法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的协议 ${parsed.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.href, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://q.qq.com/' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = intOr(res.headers.get('content-length'), 0);
    if (declared > maxBytes) throw new FileTooLargeError(declared, maxBytes);

    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new FileTooLargeError(buf.length, maxBytes);
      if (!buf.length) throw new Error('下载到空文件');
      return buf;
    }

    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new FileTooLargeError(total, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new Error('下载到空文件');
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('下载超时（15 秒）');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function runParser(filePath, kind) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    const child = spawn(process.execPath, ['--max-old-space-size=256', PARSE_SCRIPT, filePath, kind], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, PARSE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > CHILD_STDOUT_MAX) {
        try { child.kill('SIGKILL'); } catch {}
        finish(reject, new Error('解析输出过大'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < CHILD_STDERR_MAX) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(reject, new Error(`解析子进程启动失败：${error?.message ?? error}`)));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (timedOut) return finish(reject, new Error('解析超时（20 秒）'));
      if (code !== 0) {
        const detail = stderr.replace(/\s+/g, ' ').trim().slice(0, 200);
        return finish(reject, new Error(`解析子进程异常退出（code=${code}${signal ? `, signal=${signal}` : ''}）${detail ? `：${detail}` : ''}`));
      }
      let json;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        return finish(reject, new Error(`解析结果不是 JSON：${stdout.slice(0, 120)}`));
      }
      resolve(json);
    });
  });
}

// 解析子进程串行执行：每个子进程最多 256MB 堆，服务器只有 1.4G 可用，
// 并发解析几个大文件就可能把机器拖进 swap。排队只影响等待时间，不影响正确性。
let parseChain = Promise.resolve();
function runParserQueued(filePath, kind) {
  const task = parseChain.then(() => runParser(filePath, kind));
  parseChain = task.then(() => {}, () => {});
  return task;
}

async function parseBuffer(buf, kind) {
  const sniffed = sniffKind(buf, kind);
  if (sniffed === 'pdf' && !(buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-')) {
    throw new Error('不是有效的 PDF（文件头不匹配，可能已损坏）');
  }
  if ((sniffed === 'docx' || sniffed === 'xlsx') && !(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('不是有效的 Office 文档（ZIP 头不匹配，可能已损坏）');
  }
  const effectiveKind = sniffed || kind;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qq-file-'));
  const tempPath = path.join(tempDir, `input.${extForKind(effectiveKind)}`);
  try {
    await fs.promises.writeFile(tempPath, buf, { mode: 0o600 });
    return await runParserQueued(tempPath, effectiveKind);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function degrade(name, extra = '') {
  return `[文件：${name}${extra}]`;
}

async function readOnce(d, name, url, kind, maxBytes, log) {
  log(`[file] 开始读取：${name}（${kind}，声明 ${intOr(d?.file_size ?? d?.size, 0)} bytes）`);
  const buf = await downloadFile(url, maxBytes);
  const json = await parseBuffer(buf, kind);
  if (!json || json.ok !== true) throw new Error(String(json?.error ?? '解析失败'));
  const rawText = String(json.text ?? '');
  if (json.empty || !rawText.trim()) {
    log(`[file] 读取失败：提取不到文字（${kind}${kind === 'pdf' ? '，可能是扫描版' : ''}）`);
    return {
      text: degrade(name, kind === 'pdf' ? '（扫描版 PDF 或没有可提取的文字）' : '（没有可提取的文字）'),
      bytes: buf.length,
      ok: false,
    };
  }

  const sanitized = sanitizeUntrusted(rawText);
  let body = sanitized;
  if (body.length > MAX_TEXT_CHARS) {
    const totalChars = Number.isFinite(Number(json.totalChars)) ? Number(json.totalChars) : rawText.length;
    const remain = Math.max(0, totalChars - MAX_TEXT_CHARS);
    body = `${body.slice(0, MAX_TEXT_CHARS)}\n…（后面还有 ${remain} 字未显示）`;
  }
  const text = wrapUntrusted(`文件 ${name} 的正文`, body);
  log(`[file] 读取成功：${name}（${rawText.length} 字，${kind}，${buf.length} bytes）`);
  return { text, bytes: buf.length, ok: true };
}

/**
 * 读取一个 file 段并返回可直接进上下文的文本。
 * 永远不抛异常：任何失败都返回 [文件：xxx]（或更具体的降级说明）。
 *
 * @returns {Promise<{ text: string, bytes: number }>}
 *   bytes 用于同一条消息的 20MB 累计；失败时为 0（未下载或已降级）。
 */
export async function fileSegmentToText(d, { log = () => {}, maxBytes = FILE_MAX_BYTES } = {}) {
  const rawName = d?.name ?? d?.file ?? d?.filename ?? '';
  const name = fileDisplayName(rawName);
  const url = String(d?.url ?? '').trim();
  const declared = intOr(d?.file_size ?? d?.size, 0);
  const kind = kindFromName(name) || kindFromName(String(d?.file ?? ''));

  if (declared > FILE_MAX_BYTES) {
    log(`[file] 读取失败：${name} 超过 10MB（${declared} bytes）`);
    return { text: degrade(name, '（超过 10MB，读不了）'), bytes: 0 };
  }
  if (maxBytes <= 0 || declared > maxBytes) {
    log(`[file] 读取失败：${name} 超过本条消息 20MB 总量限制`);
    return { text: degrade(name, '（超过 20MB 总量限制，读不了）'), bytes: 0 };
  }
  if (!url) {
    log(`[file] 读取失败：${name} 的 file 段没有 url`);
    return { text: degrade(name), bytes: 0 };
  }
  if (!kind) {
    log(`[file] 读取失败：${unsupportedReason(name)}`);
    return { text: degrade(name), bytes: 0 };
  }

  const key = cacheKey(d, name);
  const now = Date.now();
  const cached = RESULT_CACHE.get(key);
  if (cached) {
    const ttl = cached.ok ? CACHE_TTL_MS : FAIL_CACHE_TTL_MS;
    if (now - cached.at <= ttl) return { text: cached.text, bytes: cached.bytes };
    RESULT_CACHE.delete(key);
  }
  const pending = INFLIGHT.get(key);
  if (pending) return pending;

  const job = (async () => {
    let result;
    try {
      result = await readOnce(d, name, url, kind, maxBytes, log);
    } catch (error) {
      const reason = error?.name === 'FileTooLargeError'
        ? (error.limit === 'total' ? '超过本条消息 20MB 总量限制' : '超过 10MB')
        : String(error?.message ?? error);
      log(`[file] 读取失败：${reason.slice(0, 240)}`);
      result = {
        text: error?.name === 'FileTooLargeError'
          ? degrade(name, error.limit === 'total' ? '（超过 20MB 总量限制，读不了）' : '（超过 10MB，读不了）')
          : degrade(name),
        bytes: 0,
        ok: false,
      };
    } finally {
      INFLIGHT.delete(key);
    }
    RESULT_CACHE.set(key, { at: Date.now(), text: result.text, bytes: result.bytes, ok: !!result.ok });
    while (RESULT_CACHE.size > 100) {
      RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
    }
    return { text: result.text, bytes: result.bytes };
  })();

  INFLIGHT.set(key, job);
  return job;
}
