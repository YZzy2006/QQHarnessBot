// 文件解析子进程（只能由 file-reader.js spawn）。
//
// 为什么单独进程：pdf/xlsx/mammoth 遇到畸形或超大文件可能吃爆内存 / 卡死。
// 父进程用 --max-old-space-size=256 + 20s 超时隔离，子进程崩了只会让这次
// 读取降级成 [文件：xxx]，绝不影响桥接。
//
// 输出约定：stdout **只能**有一行 JSON：
//   { "ok": true, "text": "...", "totalChars": 123, "empty": false }
//   { "ok": false, "error": "原因" }
// 库自己打的日志一律改到 stderr，避免污染 stdout。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 先接管 console，再 require 解析库（pdf.js 会在 require 后打各种 warning）。
for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
  console[method] = (...args) => {
    try {
      process.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
    } catch {}
  };
}

const MAX_CHILD_TEXT = 200000; // 父进程只截 20000 字，这里留足余量并防止 stdout 过大
const XLSX_MAX_ROWS = 5000;

const filePath = process.argv[2] ?? '';
const kind = process.argv[3] ?? '';

function emit(result) {
  try {
    fs.writeSync(1, JSON.stringify(result));
  } catch (e) {
    try { process.stderr.write(`emit failed: ${e?.message ?? e}\n`); } catch {}
  }
}

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2)));
    body.swap16();
    return body.toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {}
  // UTF-8 解码失败再按 GBK 试（国内 txt/csv 很常见）
  return require('iconv-lite').decode(buf, 'gbk');
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).replace(/\s+/g, ' ').trim();
}

async function parsePdf() {
  const pdfParse = require('pdf-parse');
  const buf = await fs.promises.readFile(filePath);
  const result = await pdfParse(buf, { max: 0 });
  return String(result?.text ?? '');
}

async function parseDocx() {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return String(result?.value ?? '');
}

async function parseXlsx() {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath, {
    cellDates: true,
    dense: true,
    sheetRows: XLSX_MAX_ROWS,
    bookVBA: false,
    bookFiles: false,
  });
  const parts = [];
  let total = 0;
  let cut = false;
  for (const sheetName of wb.SheetNames ?? []) {
    const ws = wb.Sheets?.[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
    const lines = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cells = row.map(cellText);
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.length === 0) continue;
      const line = cells.join(' | ');
      total += line.length + 1;
      if (total > MAX_CHILD_TEXT) { cut = true; break; }
      lines.push(line);
    }
    if (lines.length > 0) {
      const used = ws['!ref'];
      const full = ws['!fullref'];
      const prefix = full && used && full !== used
        ? `[工作表：${sheetName}，仅显示前 ${XLSX_MAX_ROWS} 行，完整范围 ${full}]`
        : `[工作表：${sheetName}]`;
      parts.push(prefix + '\n' + lines.join('\n'));
    }
    if (cut) break;
  }
  let text = parts.join('\n\n');
  if (cut) text += '\n…（表格内容过长，已截断）';
  return text;
}

async function parseText() {
  const buf = await fs.promises.readFile(filePath);
  return decodeText(buf);
}

async function main() {
  if (!filePath || !kind) throw new Error('缺少文件路径或类型');
  let text = '';
  if (kind === 'pdf') text = await parsePdf();
  else if (kind === 'docx') text = await parseDocx();
  else if (kind === 'xlsx') text = await parseXlsx();
  else if (kind === 'text') text = await parseText();
  else throw new Error(`未知解析类型：${kind}`);

  const totalChars = text.length;
  const empty = text.trim().length === 0;
  if (text.length > MAX_CHILD_TEXT) text = text.slice(0, MAX_CHILD_TEXT);
  emit({ ok: true, text, totalChars, empty });
}

main().catch((error) => {
  let message = String(error?.message ?? error);
  if (/password/i.test(message) || error?.name === 'PasswordException') {
    message = '文件已加密，无法读取';
  }
  emit({ ok: false, error: message.slice(0, 500) });
  process.exitCode = 0;
});
