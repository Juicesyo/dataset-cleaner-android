/**
 * OpenAI-compatible chat client.
 *
 * Only `/chat/completions` is used, since that path is implemented by OpenAI,
 * DeepSeek, Qwen, Moonshot, Ollama, vLLM, LM Studio and most gateways.
 *
 * NOTE ON KEY STORAGE: the API key lives in the app's local storage on the
 * device and is sent only to the base URL the user configures. It is never
 * persisted to a dataset file and never exported.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  /** Extra body fields merged into the request, as raw JSON. */
  extraBody: string;
}

export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个中文对话数据集校对助手。用户会给你一段对话中的某个回复。',
  '请按要求修改它：',
  '1. 只输出修改后的正文本身，不要输出解释、前后缀、Markdown 代码块或引号。',
  '2. 保持原有的语言、语气和格式（换行、列表符号等）。',
  '3. 不要添加原文不存在的新事实；不要删减有效信息，除非用户要求。',
  '4. 如果原文无需修改，原样输出。',
].join('\n');

export const DEFAULT_CONFIG: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.2,
  maxTokens: 2048,
  extraBody: '',
};

/** Normalises a user-entered base URL into a full chat-completions endpoint. */
export function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('未填写 Base URL');
  // Accept both ".../v1" and a full ".../v1/chat/completions".
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

/**
 * Performs one completion. Throws an Error with a human-readable, Chinese
 * message on failure so the UI can surface it directly in a batch report.
 */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!config.apiKey.trim()) throw new Error('未配置 API Key');

  const endpoint = resolveEndpoint(config.baseUrl);

  let extra: Record<string, unknown> = {};
  if (config.extraBody.trim()) {
    try {
      const parsed = JSON.parse(config.extraBody);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extra = parsed as Record<string, unknown>;
      } else {
        throw new Error('必须是 JSON 对象');
      }
    } catch (err) {
      throw new Error(`附加请求体不是合法 JSON: ${(err as Error).message}`);
    }
  }

  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...extra,
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // A CORS or DNS failure lands here; say so plainly rather than "Failed to fetch".
    throw new Error(`网络请求失败: ${(err as Error).message}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${truncate(raw, 300)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`响应不是 JSON: ${truncate(raw, 200)}`);
  }

  const content = extractContent(json);
  if (content === null) {
    throw new Error(`响应缺少 choices[0].message.content: ${truncate(raw, 200)}`);
  }
  return stripWrapper(content);
}

function extractContent(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === 'string') return message.content;
  // Some gateways return {text: ...} instead.
  if (typeof first.text === 'string') return first.text;
  return null;
}

/**
 * Removes the wrappers models add despite instructions: triple-backtick fences
 * and a single pair of surrounding quotes. Only stripped when the whole string
 * is wrapped, so genuine code blocks in the data survive.
 */
export function stripWrapper(text: string): string {
  let out = text.trim();
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/;
  const m = out.match(fence);
  if (m) out = m[1].trim();
  if (
    out.length > 1 &&
    ((out.startsWith('"') && out.endsWith('"')) ||
      (out.startsWith('“') && out.endsWith('”')))
  ) {
    const inner = out.slice(1, -1);
    // Only unwrap when the quotes are not balanced inside (i.e. they wrapped it).
    if (!inner.includes(out[0])) out = inner;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Builds the message list for a single-turn rewrite.
 * The user's instruction is passed separately from the data so that a
 * malicious sample cannot easily hijack the instruction channel.
 */
export function buildRewriteMessages(
  config: LlmConfig,
  instruction: string,
  context: { from: string; value: string }[],
  targetIndex: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: config.systemPrompt }];

  // Include a bounded amount of surrounding context to disambiguate the task.
  const contextText = context
    .map((t, i) => {
      const marker = i === targetIndex ? ' <<< 需要修改的回复' : '';
      return `[${i + 1}] ${t.from}: ${truncate(t.value, 1200)}${marker}`;
    })
    .join('\n');

  messages.push({
    role: 'user',
    content: [
      `修改要求：${instruction || '润色并修正错别字、标点和语病，保持原意。'}`,
      '',
      '对话上下文（最后标记的一条是需要你修改并输出的目标）：',
      contextText,
      '',
      '请只输出修改后的目标回复正文。',
    ].join('\n'),
  });

  return messages;
}

/** Simple bounded-concurrency map, used by the batch runner. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));

  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
