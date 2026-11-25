/**
 * LLM 供应商（OpenAI 兼容）
 *
 * 只依赖 fetch，不引第三方 SDK —— 这样任何 OpenAI 兼容服务都能直接用：
 *   OpenAI / DeepSeek / 通义千问 / 智谱 GLM / Moonshot / vLLM / Ollama / one-api …
 * 只要改 OPENAI_BASE_URL + OPENAI_MODEL 即可，代码零改动。
 *
 * 需要的环境变量：
 *   OPENAI_API_KEY   必填（本地 Ollama 可填任意非空值）
 *   OPENAI_BASE_URL  默认 https://api.openai.com/v1
 *   OPENAI_MODEL     默认 gpt-4o-mini
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/** 从环境变量读取配置 */
export function loadLlmConfig(env = process.env) {
  return {
    apiKey: env.OPENAI_API_KEY || '',
    baseUrl: (env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.OPENAI_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(env.OPENAI_TIMEOUT_MS || 30000),
    maxTokens: Number(env.OPENAI_MAX_TOKENS || 800),
    temperature: Number(env.OPENAI_TEMPERATURE || 0.3),
  };
}

/** 是否已具备调用条件 */
export function isLlmConfigured(env = process.env) {
  const c = loadLlmConfig(env);
  return Boolean(c.apiKey && c.baseUrl && c.model);
}

/**
 * 调用 chat/completions。
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {Object} [opts]
 * @param {Object} [opts.config]  覆盖 loadLlmConfig 的结果（测试注入用）
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
 * @returns {Promise<{text: string, usage: Object|null, model: string}>}
 */
export async function chat(messages, opts = {}) {
  const cfg = { ...loadLlmConfig(), ...(opts.config || {}) };
  const doFetch = opts.fetchImpl || globalThis.fetch;

  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY 未配置');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 不能为空');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const resp = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
      }),
      signal: controller.signal,
    });

    const raw = await resp.text();
    if (!resp.ok) {
      throw new Error(`LLM HTTP ${resp.status}: ${raw.slice(0, 300)}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`LLM 返回非 JSON: ${raw.slice(0, 200)}`);
    }

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new Error('LLM 返回结构异常：缺少 choices[0].message.content');
    }

    return { text: text.trim(), usage: data.usage || null, model: data.model || cfg.model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM 超时（${cfg.timeoutMs}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
