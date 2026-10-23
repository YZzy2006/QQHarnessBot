// 阿里云百炼 Qwen-TTS 语音合成。
//
// 为什么独立成模块：bridge.js 顶层会 main() 启动桥接，无法被测试脚本 import；
// TTS 链路需要用真实 key 单独验证。音频**流式写盘**（/tmp），不整段读进内存。
//
// 两套接口并存（按 model 前缀自动选择）：
// - qwen3-tts-*（旧）：multimodal-generation，无 instruction
// - qwen-audio-* / cosyvoice-*：audio/tts/SpeechSynthesizer，支持 input.instruction
//
// 实测（2026-10-18，qwen-audio-3.1-tts-flash / longanlingxi_v3.1）：
//   POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
//   → {"output":{"audio":{"url":"http://dashscope-result-bj.oss...wav"}}}
//   音频为 WAV/PCM 16bit mono 24kHz。注意 data chunk 的 size 是流式占位值
//   （0x7FFFFFFB 这类），不能直接用；时长按「文件实际剩余字节 / byteRate」算。
//
// key 只从环境变量读（服务通过 /etc/qq-bridge.env 注入），不写进代码。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const TTS_ENDPOINT = process.env.BAILIAN_TTS_ENDPOINT
  || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const TTS_HTTP_ENDPOINT = process.env.BAILIAN_TTS_HTTP_ENDPOINT
  || 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

export const TTS_DEFAULT_MODEL = 'qwen3-tts-flash';
export const TTS_DEFAULT_VOICE = 'Cherry';
export const TTS_DEFAULT_TIMEOUT_MS = 20000;
const TTS_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** 读 WAV 头算真实时长（只读文件头，不把音频读进内存）。 */
function readWavInfo(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const headLen = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(headLen);
    fs.readSync(fd, buf, 0, headLen, 0);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      return { format: null, duration: null };
    }
    let off = 12;
    let fmt = null;
    let dataOffset = null;
    let dataSize = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const sz = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 24 <= buf.length) {
        fmt = {
          channels: buf.readUInt16LE(off + 10),
          sampleRate: buf.readUInt32LE(off + 12),
          byteRate: buf.readUInt32LE(off + 16),
          bits: buf.readUInt16LE(off + 22)
        };
      } else if (id === 'data') {
        dataOffset = off + 8;
        dataSize = sz;
        break;
      }
      if (sz > buf.length) break; // 防御异常 chunk size，避免越界/死循环
      off += 8 + sz + (sz & 1);
    }
    if (!fmt || !dataOffset || !fmt.byteRate) {
      return { format: 'wav', duration: null, sampleRate: fmt?.sampleRate ?? null, channels: fmt?.channels ?? null };
    }
    // data size 可能是流式占位值：以文件实际剩余字节为准。
    const actual = Math.max(0, Math.min(dataSize, size - dataOffset));
    return {
      format: 'wav',
      duration: Number((actual / fmt.byteRate).toFixed(3)),
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bits: fmt.bits
    };
  } catch {
    return { format: null, duration: null };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
}

export function cleanupSpeechFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

/**
 * 把文字合成为 WAV 临时文件。
 * 返回 { path, bytes, duration, format, sampleRate, channels, model, voice, requestId, characters }。
 * 失败时抛出的 Error.message 是可直接给模型看的中文原因；不会留下半截临时文件。
 */
export async function synthesizeSpeech(text, {
  apiKey = process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
  model = TTS_DEFAULT_MODEL,
  voice = TTS_DEFAULT_VOICE,
  instruction = '',
  timeoutMs = TTS_DEFAULT_TIMEOUT_MS,
  tmpDir = os.tmpdir()
} = {}) {
  if (!apiKey) throw new Error('未配置 BAILIAN_API_KEY（检查 /etc/qq-bridge.env）');
  const input = String(text ?? '').trim();
  if (!input) throw new Error('text 不能为空');
  const instructionText = String(instruction ?? '').trim();
  // qwen-audio / cosyvoice 走新的 SpeechSynthesizer 接口，支持 instruction 与行内标签。
  const useHttpTts = /^(qwen-audio-|cosyvoice-)/i.test(String(model));
  const endpoint = useHttpTts ? TTS_HTTP_ENDPOINT : TTS_ENDPOINT;
  const requestBody = useHttpTts
    ? {
        model,
        input: {
          text: input,
          voice,
          ...(instructionText ? { instruction: instructionText } : {}),
          format: 'wav',
          sample_rate: 24000
        }
      }
    : { model, input: { text: input, voice } };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch {}
  }, Math.max(1000, Number(timeoutMs) || TTS_DEFAULT_TIMEOUT_MS));
  const timeoutText = `TTS 超时（${Math.round((Number(timeoutMs) || TTS_DEFAULT_TIMEOUT_MS) / 1000)}s）`;

  let tmpFile = null;
  try {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (error) {
      if (timedOut) throw new Error(timeoutText);
      throw new Error(`TTS 请求失败：${error?.message ?? error}`);
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = raw.slice(0, 200);
      try {
        const j = JSON.parse(raw);
        detail = j.message || j.code || detail;
      } catch {}
      if (res.status === 401 || res.status === 403) {
        throw new Error(`TTS 鉴权失败（BAILIAN_API_KEY 无效或无权限）：${detail}`);
      }
      if (res.status === 404) throw new Error(`TTS 模型不存在或已下线：${model}`);
      if (res.status === 429) throw new Error(`TTS 额度不足或请求过于频繁：${detail}`);
      throw new Error(`TTS 接口错误 HTTP ${res.status}：${detail}`);
    }
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`TTS 返回非 JSON：${raw.slice(0, 160)}`); }
    const audio = json?.output?.audio;
    const url = String(audio?.url ?? '').trim();
    if (!url) throw new Error(`TTS 未返回音频地址：${raw.slice(0, 160)}`);

    tmpFile = path.join(tmpDir, `qq-tts-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
    let written = 0;
    let dl;
    try {
      dl = await fetch(url, { signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new Error(timeoutText);
      throw new Error(`TTS 音频下载失败：${error?.message ?? error}`);
    }
    if (!dl.ok || !dl.body) throw new Error(`TTS 音频下载失败 HTTP ${dl.status}`);
    const declared = Number(dl.headers.get('content-length') || 0);
    if (declared > TTS_MAX_AUDIO_BYTES) throw new Error(`TTS 音频过大（${declared} bytes）`);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > TTS_MAX_AUDIO_BYTES) { cb(new Error('TTS 音频过大')); return; }
        cb(null, chunk);
      }
    });
    try {
      await pipeline(Readable.fromWeb(dl.body), counter, fs.createWriteStream(tmpFile));
    } catch (error) {
      if (timedOut) throw new Error(timeoutText);
      throw error;
    }
    if (!written) throw new Error('TTS 下载到空音频');
    const info = readWavInfo(tmpFile);
    return {
      path: tmpFile,
      bytes: written,
      duration: info.duration ?? null,
      format: info.format || 'wav',
      sampleRate: info.sampleRate ?? null,
      channels: info.channels ?? null,
      bits: info.bits ?? null,
      model,
      voice,
      instruction: instructionText || null,
      requestId: json.request_id ?? null,
      characters: json.usage?.characters ?? null
    };
  } catch (error) {
    cleanupSpeechFile(tmpFile);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
