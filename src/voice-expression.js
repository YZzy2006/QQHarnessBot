// Small, provider-side expression controls: no local model or persistent state.
const DEFAULT_STYLES = {
  coax: ['撒娇', '声音软、带笑，尾音轻，亲近但不刻意卖萌。'],
  happy: ['开心', '轻快、明亮，带一点笑意，语速稍快。'],
  gentle: ['温柔陪伴', '声音放软，认真倾听，真诚安慰，不煽情。'],
  serious: ['认真', '语气稳、放轻，认真说事，不卖萌。'],
  tired: ['困倦', '声音轻、稍慢，有一点困意，保持吐字清楚。'],
  sing: ['哼唱', '轻快带旋律地哼唱。'],
  playful: ['调皮', '像跟熟人开小玩笑，俏皮、带笑，别阴阳怪气。'],
  shy: ['害羞', '有一点不好意思，声音轻，略微迟疑，不夸张卖萌。'],
  sad: ['失落', '有一点失落，语速稍慢、声音放低，不哭喊。'],
  surprised: ['惊讶', '短暂惊讶，音调略扬，接着恢复自然，不尖叫。'],
  worried: ['担心', '关心对方，稍显担忧，语气认真、柔和，不慌张。'],
  whisper: ['低声', '贴近地轻声说话，音量放低，保持清楚自然。']
};
const INTENSITY = {
  subtle: '情绪轻微，自然克制。',
  normal: '情绪适中，自然表达。',
  strong: '情绪明显，保持自然，不喊叫。'
};
const CONTROL_TAGS = new Set(['sad', 'amazed', 'excited', 'curious', 'tired', 'mischievously', 'empathetic', 'whispers', 'reluctantly', 'serious']);
const NONVERBAL_TAGS = new Set(['giggles', 'sighing']);

export const VOICE_EXPRESSION_HINT = '情绪默认轻微自然；intensity 可选 subtle/normal/strong，不为增加情绪而增加语音频率。text 可少量使用 [mischievously]/[curious]/[amazed]/[sad]/[empathetic]/[whispers]/[reluctantly]/[serious]/[excited]/[tired] 控制后续语气，[giggles]/[sighing] 插入拟声；每条最多3个标签，拟声最多1次，普通聊天通常不用。示例：[mischievously]才没有等你呢。[giggles]；安慰用 gentle，别因为对方难过就跟着哭。标签只用于语音 text，文字消息不要带标签。';

export function voiceStyles(configured) {
  const result = Object.create(null);
  for (const [id, [label, instruction]] of Object.entries(DEFAULT_STYLES)) result[id] = { label, instruction };
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    for (const [id, value] of Object.entries(configured)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id) || id === 'daily' || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (typeof value.instruction !== 'string' || !value.instruction.trim()) continue;
      result[id] = { label: String(value.label ?? id).slice(0, 40), instruction: value.instruction.trim() };
    }
  }
  return result;
}

function truncateInstruction(value, maxWeight) {
  let weight = 0, result = '';
  for (const ch of String(value ?? '')) {
    weight += /[㐀-鿿豈-﫿]/u.test(ch) ? 2 : 1;
    if (weight > maxWeight) break;
    result += ch;
  }
  return result.trim();
}

export function prepareVoiceExpression({ text, profile = {}, style = {}, intensity = 'subtle' }) {
  if (!Object.hasOwn(INTENSITY, intensity)) throw new Error('未知情绪强度，可选 subtle、normal、strong');
  const raw = String(text ?? '');
  if ([...raw].length > 400) throw new Error('含标签的语音文本最多400字');
  const ttsText = raw.trim();
  let tags = 0, nonverbal = 0;
  const plain = ttsText.replace(/\[([a-zA-Z][a-zA-Z _-]*)\]/g, (match, tag) => {
    if (!CONTROL_TAGS.has(tag) && !NONVERBAL_TAGS.has(tag)) throw new Error(`不支持的语音标签：${match}`);
    if (!/^qwen-audio-(3\.1|3\.0)-tts-/i.test(profile.model || '')) throw new Error('当前语音模型不支持情感标签');
    if (++tags > 3) throw new Error('每条语音最多3个情感标签');
    if (NONVERBAL_TAGS.has(tag) && ++nonverbal > 1) throw new Error('每条语音最多1次拟声');
    return '';
  }).trim();
  const chars = [...plain].length;
  if (!chars) throw new Error('语音正文不能为空');
  if (chars > 200) throw new Error('语音正文最多200字');
  // Qwen-Audio accepts free-form instructions. Retain CosyVoice's conservative
  // 100 weighted-character limit; the existing Qwen adapter uses the same field.
  const limit = /^qwen-audio-/i.test(profile.model || '') ? 300 : 100;
  const strength = INTENSITY[intensity];
  const share = Math.floor((limit - [...strength].length * 2 - 4) / 2);
  const instructions = [...new Set([profile.instruction, style.instruction].filter(Boolean))];
  const instruction = [...instructions.map(s => truncateInstruction(s, share)), strength].join('；');
  return { text: plain, ttsText, chars, intensity, instruction: truncateInstruction(instruction, limit) };
}
