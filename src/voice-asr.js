// QQ 语音消息转文字：SILK → WAV → 阿里云百炼 ASR。
//
// 为什么放在单独模块：bridge.js 顶部就会 main() 启动桥接，无法被测试脚本 import；
// 语音链路（下载/解码/ASR）需要能用真实样本单独验证，所以独立成模块。
//
// 解码：silk-wasm（纯 WASM，无系统依赖）。QQ 下发的是腾讯 SILK 变体
// `\x02#!SILK_V3...`（比标准头多一个 0x02 前缀字节）；silk-wasm 的块解析
// 本身按“首字节===2 则跳过 10 字节头”处理，直接喂原始 buffer 即可，不需手动剥前缀。
//
// ASR：百炼 OpenAI 兼容接口 /compatible-mode/v1/chat/completions，
// 模型 qwen3-asr-flash，音频以 base64 data URL 传入（该接口不吃 multipart 文件，
// /compatible-mode/v1/audio/transcriptions 实测 404）。
import { decode as silkDecode } from 'silk-wasm';

export const VOICE_PCM_SAMPLE_RATE = 16000;
const VOICE_DOWNLOAD_TIMEOUT_MS = 8000;
const VOICE_ASR_TIMEOUT_MS = 15000;
const VOICE_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const VOICE_CACHE_TTL_MS = 5 * 60 * 1000;   // 同一 URL 的转写结果缓存 5 分钟
const VOICE_FAIL_CACHE_TTL_MS = 60 * 1000;  // 失败只缓存 1 分钟，避免同一语音的重复段连续超时两次
const VOICE_RESULT_CACHE = new Map();       // key -> { at, text|null }
const VOICE_INFLIGHT = new Map();           // key -> Promise<string|null>（并发去重）

function voiceCacheKey(d) {
  const url = String(d?.url ?? '').trim();
  if (url) return url;
  const file = String(d?.file ?? '').trim();
  return file ? `file:${file}` : '';
}

export function pcm16ToWav(pcm, sampleRate = VOICE_PCM_SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(1, 22);              // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);              // block align
  header.writeUInt16LE(16, 34);             // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function downloadVoiceAudio(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://q.qq.com/' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > VOICE_MAX_AUDIO_BYTES) throw new Error(`音频过大 ${declared} bytes`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('下载到空音频');
    if (buf.length > VOICE_MAX_AUDIO_BYTES) throw new Error(`音频过大 ${buf.length} bytes`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export async function silkToWav(silk) {
  // 只做一次头校验，避免把 HTML/JSON 错误页当音频送去解码。
  if (!silk.subarray(0, 10).toString('latin1').includes('#!SILK')) {
    throw new Error(`不是 SILK 数据（头=${silk.subarray(0, 6).toString('hex')}）`);
  }
  const { data, duration } = await silkDecode(silk, VOICE_PCM_SAMPLE_RATE);
  const pcm = Buffer.from(data);
  if (!pcm.length) throw new Error('SILK 解码结果为空');
  return { wav: pcm16ToWav(pcm), durationMs: duration, pcm };
}

export async function transcribeWav(wav) {
  const apiKey = process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey) throw new Error('未配置 BAILIAN_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_ASR_TIMEOUT_MS);
  try {
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'qwen3-asr-flash',
        messages: [{
          role: 'user',
          content: [{
            type: 'input_audio',
            input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}`, format: 'wav' }
          }]
        }],
        stream: false
      })
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`ASR HTTP ${res.status} ${raw.slice(0, 160)}`);
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`ASR 返回非 JSON：${raw.slice(0, 160)}`); }
    const content = json?.choices?.[0]?.message?.content;
    const text = (typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : ''
    ).trim();
    if (!text) throw new Error('ASR 返回空文本');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function pruneVoiceCache(now) {
  for (const [key, entry] of VOICE_RESULT_CACHE) {
    const ttl = entry.text ? VOICE_CACHE_TTL_MS : VOICE_FAIL_CACHE_TTL_MS;
    if (now - entry.at > ttl) VOICE_RESULT_CACHE.delete(key);
  }
  while (VOICE_RESULT_CACHE.size > 100) {
    VOICE_RESULT_CACHE.delete(VOICE_RESULT_CACHE.keys().next().value);
  }
}

/**
 * 把 record 段转成文字。
 * 成功返回文本；任何失败返回 null（调用方降级为 [语音]），并把原因交给 log。
 * 同一个 url 的并发调用共享同一个 Promise；成功结果缓存 5 分钟。
 */
export async function voiceSegmentToText(d, { log = () => {} } = {}) {
  const key = voiceCacheKey(d);
  if (!key) return null;
  const now = Date.now();
  const cached = VOICE_RESULT_CACHE.get(key);
  if (cached) {
    const ttl = cached.text ? VOICE_CACHE_TTL_MS : VOICE_FAIL_CACHE_TTL_MS;
    if (now - cached.at <= ttl) return cached.text;
    VOICE_RESULT_CACHE.delete(key);
  }
  const pending = VOICE_INFLIGHT.get(key);
  if (pending) return pending;
  const job = (async () => {
    let text = null;
    try {
      if (!d?.url) throw new Error('record 段没有 url');
      const silk = await downloadVoiceAudio(String(d.url));
      const { wav, durationMs } = await silkToWav(silk);
      text = await transcribeWav(wav);
      log(`[voice] 转写成功（${durationMs}ms 音频）：${text.slice(0, 80)}`);
    } catch (e) {
      const reason = e?.name === 'AbortError' ? '请求超时' : String(e?.message ?? e);
      log(`[voice] 转写失败，降级为 [语音]：${reason.slice(0, 200)}`);
      text = null;
    } finally {
      VOICE_INFLIGHT.delete(key);
    }
    VOICE_RESULT_CACHE.set(key, { at: Date.now(), text });
    pruneVoiceCache(Date.now());
    return text;
  })();
  VOICE_INFLIGHT.set(key, job);
  return job;
}
