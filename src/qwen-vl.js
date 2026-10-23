// 千问 VL 识图兜底：DeepSeek 读不了/读不懂图片时，用百炼 Qwen-VL 生成文字描述。
//
// 为什么放这里：QQ 图片可能是大 GIF、超大原图或格式 DeepSeek 视觉不吃的；
// 桥接先尝试自己取图，取不到或超过直读阈值时，把 URL/字节交给千问描述，
// 至少让模型拿到“图里有什么”，而不是对着占位符瞎猜。
//
// 百炼 OpenAI 兼容接口；2026-10-20 实测该账号可用模型是 qwen3-vl-plus
// （qwen3-vl-flash 返回 model_not_found）。

export const QWEN_VL_DEFAULT_MODEL = 'qwen3-vl-plus';
export const QWEN_VL_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const QWEN_VL_DEFAULT_PROMPT = '用中文简洁描述这张图片的内容；如果有文字、数字或界面信息，提取关键部分。看不清的地方不要编造。';

function resolveKey(explicit) {
  return String(explicit || process.env.QWEN_API_KEY || process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || '').trim();
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

function truncateByCodePoint(text, maxChars) {
  const s = String(text ?? '').trim();
  const limit = Math.max(1, Number(maxChars) || 600);
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}

/**
 * 调用千问 VL 描述一张图片。
 * @param {object} args
 * @param {string} [args.url]       图片 URL（http/https）；大图优先用它，避免本地 base64 再翻一倍
 * @param {Buffer} [args.buffer]    图片字节；没有 URL 或图片较小时用
 * @param {string} [args.mimeType]  图片 MIME
 * @param {string} [args.prompt]    给模型的提示词
 * @param {string} [args.model]     默认 qwen3-vl-plus
 * @param {number} [args.timeoutMs] 默认 60s
 * @param {number} [args.maxChars]  返回描述最大字符数
 * @param {string} [args.apiKey]    可选，默认读 QWEN_API_KEY / BAILIAN_API_KEY / DASHSCOPE_API_KEY
 * @param {Function} [args.fetchImpl] 测试注入
 * @param {string} [args.endpoint]  测试/代理用
 * @returns {Promise<string>}
 */
export async function describeImage({
  url = '',
  buffer = null,
  mimeType = '',
  prompt = QWEN_VL_DEFAULT_PROMPT,
  model = QWEN_VL_DEFAULT_MODEL,
  timeoutMs = 60000,
  maxChars = 600,
  apiKey = '',
  fetchImpl = fetch,
  endpoint = QWEN_VL_ENDPOINT
} = {}) {
  const key = resolveKey(apiKey);
  if (!key) throw new Error('未配置 QWEN_API_KEY / BAILIAN_API_KEY / DASHSCOPE_API_KEY');
  const httpUrl = /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
  const hasBuffer = Buffer.isBuffer(buffer) && buffer.length > 0;
  if (!httpUrl && !hasBuffer) throw new Error('没有可用的图片 URL 或字节');
  // 大图优先让百炼按 URL 拉取，避免 base64 让请求体积再涨 4/3。
  const useUrl = Boolean(httpUrl) && (!hasBuffer || buffer.length > 2 * 1024 * 1024);
  const dataUrl = hasBuffer
    ? `data:${String(mimeType || 'image/jpeg')};base64,${buffer.toString('base64')}`
    : '';
  const primary = useUrl ? httpUrl : dataUrl;
  const secondary = useUrl ? dataUrl : (httpUrl || '');

  async function attempt(imageUrl) {
    const body = {
      model: String(model || QWEN_VL_DEFAULT_MODEL),
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: String(prompt || QWEN_VL_DEFAULT_PROMPT) }
        ]
      }]
    };
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 60000))
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json?.error?.message || json?.message || json?.error?.code || `HTTP ${res.status}`;
      throw new Error(`千问识图失败：${detail}`);
    }
    const content = json?.choices?.[0]?.message?.content;
    const text = textOfContent(content).trim();
    if (!text) throw new Error('千问识图没有返回文字描述');
    return truncateByCodePoint(text, maxChars);
  }

  try {
    return await attempt(primary);
  } catch (firstError) {
    // QQ 图片 URL 带 rkey，过期后百炼会报 “Failed to download multimodal content”；
    // 此时如果本地已有字节，改用 base64 再试一次（请求会大一些，但比直接失败好）。
    if (!secondary || secondary === primary) throw firstError;
    try {
      return await attempt(secondary);
    } catch (secondError) {
      throw new Error(`${firstError.message}；改用图片字节重试仍失败：${secondError.message}`);
    }
  }
}
