// Image generation providers.
//
// qwen (default):
//   fast  z-image-turbo   ¥0.10/张  ~3-4s
//   high  qwen-image-3.0  ¥0.18/张  ~4-5s
// doubao (opt-in):
//   doubao-seedream-5-0-flash-260915 ¥0.12/张 ~8s
//
// Both providers return a temporary URL; we download it immediately with the
// bridge's SSRF-safe fetcher and never hand the URL to OneBot or the model.
import { safeFetchBuffer } from './safe-fetch.js';

export const IMAGE_PROVIDERS = Object.freeze({
  qwen: 'qwen',
  doubao: 'doubao'
});

export const IMAGE_MODELS = Object.freeze({
  fast: Object.freeze({ id: 'z-image-turbo', label: 'Z-Image Turbo', costCny: 0.1, timeoutMs: 60000 }),
  high: Object.freeze({ id: 'qwen-image-3.0', label: 'Qwen-Image 3.0', costCny: 0.18, timeoutMs: 90000 })
});

export const DOUBAO_IMAGE_MODEL = Object.freeze({
  id: 'doubao-seedream-5-0-flash-260915',
  label: 'Seedream 5.0 Flash',
  costCny: 0.12,
  timeoutMs: 90000
});

export const IMAGE_SIZES = Object.freeze({
  square: Object.freeze({ width: 1024, height: 1024, label: '1:1' }),
  landscape: Object.freeze({ width: 1280, height: 720, label: '16:9' }),
  portrait: Object.freeze({ width: 720, height: 1280, label: '9:16' })
});

export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const IMAGE_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const DOUBAO_IMAGE_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

export function resolveImageProvider(provider) {
  return String(provider || '').toLowerCase() === 'doubao' ? IMAGE_PROVIDERS.doubao : IMAGE_PROVIDERS.qwen;
}

export function resolveImageModel(quality) {
  const key = String(quality || '').toLowerCase();
  return IMAGE_MODELS[key] || IMAGE_MODELS.fast;
}

export function resolveImageSize(size) {
  const key = String(size || '').toLowerCase();
  return { key: IMAGE_SIZES[key] ? key : 'square', ...(IMAGE_SIZES[key] || IMAGE_SIZES.square) };
}

export function validateImagePrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt 不能为空');
  if (text.length > 800) throw new Error('prompt 最多 800 字');
  return text;
}

function detectImageType(buffer) {
  if (!buffer || buffer.length < 4) return { contentType: 'application/octet-stream', ext: 'bin' };
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return { contentType: 'image/gif', ext: 'gif' };
  }
  return { contentType: 'application/octet-stream', ext: 'bin' };
}

/**
 * Generate one image and return its bytes plus cost/model metadata.
 * `provider` is 'qwen' (default) or 'doubao'; the caller passes the matching
 * API key. Never returns the temporary provider URL.
 */
export async function generateImage({
  provider = 'qwen',
  prompt,
  quality = 'fast',
  size = 'square',
  apiKey,
  fetchImpl = fetch,
  now = Date.now()
} = {}) {
  const text = validateImagePrompt(prompt);
  const providerKey = resolveImageProvider(provider);
  const expectedKey = providerKey === 'doubao' ? 'DOUBAO_API_KEY' : 'QWEN_API_KEY / BAILIAN_API_KEY';
  if (!apiKey) throw new Error(`未配置 ${expectedKey}`);
  const dims = resolveImageSize(size);
  const started = now;

  const qwenModel = resolveImageModel(quality);
  const model = providerKey === 'doubao' ? DOUBAO_IMAGE_MODEL : qwenModel;
  const apiUrl = providerKey === 'doubao' ? DOUBAO_IMAGE_API_URL : IMAGE_API_URL;
  const body = providerKey === 'doubao'
    ? {
        model: model.id,
        prompt: text,
        size: dims.key === 'square' ? '1K' : `${dims.width}x${dims.height}`,
        response_format: 'url',
        watermark: false
      }
    : {
        model: model.id,
        input: { messages: [{ role: 'user', content: [{ text }] }] },
        parameters: {
          size: `${dims.width}*${dims.height}`,
          n: 1,
          prompt_extend: false,
          watermark: false
        }
      };

  let res;
  try {
    res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(model.timeoutMs)
    });
  } catch (error) {
    const wrapped = new Error(`生图网络错误：${error?.message ?? error}`);
    wrapped.fallbackable = true;
    throw wrapped;
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const detail = String(data?.error?.message || data?.message || data?.error?.code || data?.code || raw).slice(0, 220);
    const hint = providerKey === 'doubao' && /ModelNotOpen/i.test(detail)
      ? '（豆包模型未开通或当前 key 无权限）'
      : '';
    const error = new Error(`生图 API HTTP ${res.status}: ${detail}${hint}`);
    // API 明确拒绝/限流/模型不可用时没有出图，可安全切另一个 provider。
    error.fallbackable = true;
    throw error;
  }

  const qwenContent = data?.output?.choices?.[0]?.message?.content;
  const imageUrl = providerKey === 'doubao'
    ? String(data?.data?.[0]?.url || '')
    : (Array.isArray(qwenContent) ? (qwenContent.find((item) => item && item.image)?.image || '') : '');
  if (!imageUrl) {
    const detail = String(data?.error?.message || data?.message || data?.code || raw).slice(0, 220);
    const error = new Error(`生图返回中没有图片 URL：${detail}`);
    // 200 已可能计费，不再切 provider，避免重复扣费。
    error.fallbackable = false;
    throw error;
  }

  let fetched;
  try {
    fetched = await safeFetchBuffer(imageUrl, IMAGE_MAX_BYTES);
  } catch (error) {
    const wrapped = new Error(`图片下载失败：${error?.message ?? error}`);
    // 图片已经生成并可能已计费；重试另一个 provider 会重复扣费。
    wrapped.fallbackable = false;
    throw wrapped;
  }
  const detected = detectImageType(fetched.buffer);
  if (!detected.contentType.startsWith('image/')) {
    const error = new Error(`返回内容不是图片：${detected.contentType}`);
    error.fallbackable = false;
    throw error;
  }

  return {
    buffer: fetched.buffer,
    contentType: detected.contentType,
    ext: detected.ext,
    provider: providerKey,
    model: model.id,
    modelLabel: model.label,
    quality: providerKey === 'doubao' ? 'doubao' : (model === IMAGE_MODELS.high ? 'high' : 'fast'),
    size: dims.key,
    width: dims.width,
    height: dims.height,
    costCny: model.costCny,
    requestId: String(data?.request_id || ''),
    elapsedMs: Date.now() - started
  };
}

/**
 * Try the requested provider first, then the other one on a fallbackable
 * generation failure (qwen <-> doubao). Non-fallbackable errors (image was
 * already generated but couldn't be downloaded) stop immediately to avoid
 * double billing.
 *
 * `generate` is injectable for tests. Returns:
 *   { result, fallbackFrom, errors }
 * where fallbackFrom is null when the primary succeeded.
 */
export async function generateImageWithFallback({
  provider = 'qwen',
  prompt,
  quality = 'fast',
  size = 'square',
  keys = {},
  generate = generateImage,
  fetchImpl = fetch,
  now = Date.now()
} = {}) {
  const primary = resolveImageProvider(provider);
  const order = primary === 'doubao' ? ['doubao', 'qwen'] : ['qwen', 'doubao'];
  const errors = [];
  for (const providerKey of order) {
    const apiKey = String(keys?.[providerKey] || '');
    if (!apiKey) {
      errors.push({ provider: providerKey, error: '缺少 API key' });
      continue;
    }
    try {
      const result = await generate({
        provider: providerKey,
        prompt,
        quality,
        size,
        apiKey,
        fetchImpl,
        now
      });
      return {
        result,
        fallbackFrom: providerKey === primary ? null : primary,
        errors
      };
    } catch (error) {
      errors.push({ provider: providerKey, error: String(error?.message ?? error) });
      if (error && error.fallbackable === false) break;
    }
  }
  const message = errors.map((item) => `${item.provider}: ${item.error}`).join('；') || '没有可用的生图 key';
  const error = new Error(`生图失败（已尝试兜底）：${message}`);
  error.attempts = errors;
  throw error;
}
