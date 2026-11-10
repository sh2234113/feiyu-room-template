// BreezeBlue 语音合成客户端（TTS）。
//
// 用途：把小蓝鱼要「说」的那句话合成成音频文件，交给现有的语音发送链路
// （/api/socialV2/send-voice → sendVoiceForV2）当语音条发出去。
//
// 约定：
// - 只做「文字 → 音频 Buffer」，不落盘、不发送；落盘/发送由 bridge 负责。
// - 密钥只从环境变量或 config 读取，不写日志、不进错误信息。
// - Breeze 的 API 不是 OpenAI TTS 兼容接口：鉴权是 xi-api-key，输出格式走 query。
// - 失败要区分「没提交成功」和「可能已计费」：HTTP 非 2xx 我们视为未成功合成。
import { BREEZE_DEFAULT_BASE, BREEZE_VOICES } from './breeze-voices.js';

export { BREEZE_VOICES };

export class BreezeError extends Error {
  constructor(message, { status = 0, code = '', retryable = false } = {}) {
    super(message);
    this.name = 'BreezeError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** 从 config.breeze 与环境变量解析出实际参数。apiKey 缺失时 enabled 仍为 true，但调用会明确报错。 */
export function resolveBreezeConfig(raw = {}, env = process.env) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const apiKey = String(env?.[cfg.apiKeyEnv || 'BREEZE_API_KEY'] || cfg.apiKey || '').trim();
  const voiceAlias = String(cfg.voice || 'clever').trim();
  const voiceId = BREEZE_VOICES[voiceAlias] || (/^voc_/.test(voiceAlias) ? voiceAlias : BREEZE_VOICES.clever);
  return {
    enabled: cfg.enabled !== false,
    apiKey,
    baseUrl: String(cfg.baseUrl || BREEZE_DEFAULT_BASE).replace(/\/+$/, ''),
    voiceId,
    voiceAlias: BREEZE_VOICES[voiceAlias] ? voiceAlias : (voiceId === BREEZE_VOICES.dreamy ? 'dreamy' : 'clever'),
    modelId: String(cfg.modelId || '').trim() || null,
    languageCode: String(cfg.languageCode || 'zh').trim() || 'zh',
    outputFormat: String(cfg.outputFormat || 'mp3_24000_64').trim(),
    instructions: String(cfg.instructions || '').trim(),
    maxChars: Math.max(1, Math.round(Number(cfg.maxChars) || 120)),
    dailyLimit: Math.max(0, Math.round(Number(cfg.dailyLimit) || 0)),
    timeoutMs: Math.max(5000, Math.round(Number(cfg.timeoutMs) || 60000))
  };
}

/**
 * 合成一段语音。
 * @returns {Promise<{buffer: Buffer, contentType: string, chars: number, voiceId: string}>}
 */
export async function synthesizeSpeech({
  text,
  voiceId,
  apiKey,
  baseUrl = BREEZE_DEFAULT_BASE,
  modelId = null,
  languageCode = 'zh',
  outputFormat = 'mp3_24000_64',
  instructions = '',
  timeoutMs = 60000,
  fetchImpl = fetch
} = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new BreezeError('要合成的文字是空的');
  if (!apiKey) {
    throw new BreezeError('没有配置 Breeze API Key：在 https://breezeblue.ai/app/developer/api-keys 创建后，写进环境变量 BREEZE_API_KEY（或 config.json 的 breeze.apiKey）', { code: 'no-api-key' });
  }
  if (!voiceId) throw new BreezeError('没有指定 voiceId');

  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const body = { text: clean };
  if (modelId) body.model_id = modelId;
  if (languageCode) body.language_code = languageCode;
  if (instructions) body.instructions = instructions;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 60000))
    });
  } catch (error) {
    throw new BreezeError(`连接 Breeze 失败：${error?.message ?? error}`, { code: 'network', retryable: true });
  }

  if (!res.ok) {
    // 错误体可能是 JSON；只提取 message/code，绝不回显请求头。
    let detail = '';
    let code = '';
    try {
      const data = await res.json();
      detail = String(data?.detail?.message || data?.message || data?.error || '');
      code = String(data?.detail?.code || data?.code || '');
    } catch {
      try { detail = (await res.text()).slice(0, 200); } catch {}
    }
    const hints = {
      401: 'API Key 无效或已停用',
      402: '额度不足（API Key 预算或账户 credits 用尽）',
      403: '没有权限使用这个音色',
      404: '音色不存在',
      422: '请求参数不合法',
      429: '触发限流，稍后再试'
    };
    const hint = hints[res.status] ? `${hints[res.status]}；` : '';
    throw new BreezeError(`${hint}Breeze 合成失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, {
      status: res.status,
      code: code || `http-${res.status}`,
      retryable: res.status === 429 || res.status >= 500
    });
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new BreezeError('Breeze 返回了空音频', { code: 'empty-audio' });
  return {
    buffer,
    contentType: String(res.headers.get('content-type') || 'audio/mpeg'),
    chars: clean.length,
    voiceId
  };
}
