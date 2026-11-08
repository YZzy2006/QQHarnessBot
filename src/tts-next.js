// 阿里云百炼 Qwen-Audio-3.1-TTS-Next（Audiogen）唱一小段。
//
// 它接受 text_prompt（歌词 + 旋律描述/简谱/ABC），输出 MP3。
// 注意：它不是乐谱/MIDI 模型；melody 只是提示词，不能保证 100% 原谱。
// 实测（2026-10-18）：只写前两句歌词 + ABC 谱，约 12 秒；45 秒约 ¥0.11。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 3000;

export function buildSongPrompt({ lyrics, melody = '', title = '', style = '' }) {
  const lyr = String(lyrics ?? '').trim();
  const mel = String(melody ?? '').trim();
  const st = String(style ?? '').trim() || '轻快童谣';
  const name = String(title ?? '').trim();
  const base = mel
    ? `女声清唱，严格按以下旋律：${mel}。只唱歌词：${lyr}`
    : `女声用普通话清唱${name ? `《${name}》` : ''}，只唱：${lyr}`;
  return `${base}唱完这一段就停，不要重复，不要唱完整首。风格：${st}。带简单钢琴伴奏。`;
}

export function cleanupSongFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

export async function synthesizeSong(lyrics, {
  melody = '',
  title = '',
  style = '',
  apiKey = process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
  timeoutMs = 180000,
  endpoint = process.env.BAILIAN_TTS_NEXT_ENDPOINT || DEFAULT_ENDPOINT,
  tmpDir = os.tmpdir()
} = {}) {
  if (!apiKey) throw new Error('未配置 BAILIAN_API_KEY（检查 /etc/qq-bridge.env）');
  const lyr = String(lyrics ?? '').trim();
  if (!lyr) throw new Error('lyrics 不能为空');
  const prompt = buildSongPrompt({ lyrics: lyr, melody, title, style });
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`唱歌描述太长（上限 ${MAX_PROMPT_CHARS} 字符）`);
  }

  const timeout = Math.max(30000, Number(timeoutMs) || 180000);
  const signal = AbortSignal.timeout(timeout);
  let tmpFile = null;
  try {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen-audio-3.1-tts-next',
          input: { text_prompt: prompt, format: 'mp3', sample_rate: 48000, channels: 2 }
        }),
        signal
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error(`唱歌超时（${Math.round(timeout / 1000)}s）`);
      }
      throw new Error(`唱歌请求失败：${error?.message ?? error}`);
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = raw.slice(0, 200);
      try {
        const j = JSON.parse(raw);
        detail = j.message || j.code || detail;
      } catch {}
      if (res.status === 401 || res.status === 403) throw new Error(`唱歌鉴权失败：${detail}`);
      if (res.status === 429) throw new Error(`唱歌额度不足或请求过于频繁：${detail}`);
      if (res.status === 404) throw new Error(`唱歌模型不存在或已下线：${detail}`);
      throw new Error(`唱歌接口错误 HTTP ${res.status}：${detail}`);
    }
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`唱歌返回非 JSON：${raw.slice(0, 160)}`); }
    const audio = json?.output?.audio;
    const url = String(audio?.url ?? '').trim();
    if (!url) throw new Error(`唱歌未返回音频地址：${raw.slice(0, 160)}`);

    tmpFile = path.join(tmpDir, `qq-sing-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`);
    let written = 0;
    let dl;
    try {
      dl = await fetch(url, { signal });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error(`唱歌音频下载超时`);
      }
      throw new Error(`唱歌音频下载失败：${error?.message ?? error}`);
    }
    if (!dl.ok || !dl.body) throw new Error(`唱歌音频下载失败 HTTP ${dl.status}`);
    const declared = Number(dl.headers.get('content-length') || 0);
    if (declared > MAX_AUDIO_BYTES) throw new Error(`唱歌音频过大（${declared} bytes）`);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > MAX_AUDIO_BYTES) { cb(new Error('唱歌音频过大')); return; }
        cb(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(dl.body), counter, fs.createWriteStream(tmpFile));
    if (!written) throw new Error('唱歌下载到空音频');

    const duration = Number(audio?.duration);
    const usage = json?.usage ?? null;
    return {
      path: tmpFile,
      bytes: written,
      duration: Number.isFinite(duration) ? duration : (Number(usage?.duration) || null),
      format: 'mp3',
      model: 'qwen-audio-3.1-tts-next',
      requestId: json?.request_id ?? null,
      usage,
      prompt
    };
  } catch (error) {
    cleanupSongFile(tmpFile);
    throw error;
  }
}
