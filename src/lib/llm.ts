/**
 * OpenAI-compatible chat client.
 *
 * Only `/chat/completions` and `/models` are used, since those paths are
 * implemented by OpenAI, DeepSeek, Qwen, Moonshot, Ollama, vLLM, LM Studio and
 * most gateways.
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
  /**
   * Tags wrapping a reasoning model's scratchpad, e.g. `<think>` / `</think>`.
   *
   * Reasoning models such as DeepSeek-R1 or QwQ emit their chain of thought
   * inline in `content`. Writing that into a dataset would be wrong, and it also
   * makes batch output look chaotic, so anything between the tags is dropped.
   */
  /**
   * Whether the endpoint is a reasoning model that emits thinking blocks.
   *
   * Kept separate from `thinkingMode` so toggling the model type preserves the
   * user's chosen stripping strategy. A non-reasoning model is never stripped:
   * any thinking-looking tags in its output belong to the data being rewritten.
   */
  reasoningModel: boolean;
  thinkingStartTag: string;
  thinkingEndTag: string;
  /** How aggressively to remove reasoning from the model's output. */
  thinkingMode: ThinkingMode;
}

export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个中文对话数据集校对助手。用户会给你一段对话中的某个回复。',
  '请按要求修改它：',
  '1. 只输出修改后的正文本身，不要输出解释、前后缀、Markdown 代码块或引号。',
  '2. 不要输出你的思考过程；如果你使用思考标记，请确保最终答案在标记之外。',
  '3. 保持原有的语言、语气和格式（换行、列表符号等）。',
  '4. 不要添加原文不存在的新事实；不要删减有效信息，除非用户要求。',
  '5. 如果原文无需修改，原样输出。',
].join('\n');

export const DEFAULT_CONFIG: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.2,
  // Generous by default: a rewrite can legitimately be as long as its input,
  // and a too-small ceiling silently truncates the result.
  maxTokens: 4096,
  extraBody: '',
  thinkingStartTag: '<think>',
  thinkingEndTag: '</think>',
  thinkingMode: 'auto',
  reasoningModel: true,
};

/**
 * The stripping mode actually applied for a configuration.
 *
 * A model flagged as non-reasoning never has its output stripped: any
 * thinking-looking tags there come from the data, not from the model.
 */
export function effectiveThinkingMode(
  config: Pick<LlmConfig, 'reasoningModel' | 'thinkingMode'>,
): ThinkingMode {
  return config.reasoningModel ? config.thinkingMode : 'never';
}

/**
 * Guesses whether a model id belongs to a reasoning family.
 *
 * Used only to pre-select the model type when the user picks from the fetched
 * list, and the result is reported in the UI so it is never a silent change.
 */
export function looksLikeReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return [
    // OpenAI o-series, DeepSeek reasoner, Qwen QwQ / thinking, generic markers.
    /(^|[/\-_])o[1-9](\b|[-_.])/,
    /deepseek[-_]?r1/,
    /reasoner/,
    /qwq/,
    /[-_.]r1(\b|[-_.])/,
    /thinking/,
    /[-_.]think(\b|[-_.])/,
    /reasoning/,
    /magistral/,
  ].some((re) => re.test(id));
}

/** Strips a trailing `/chat/completions` so other endpoints can be appended. */
function baseRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('未填写 Base URL');
  return trimmed.replace(/\/chat\/completions$/, '');
}

/** Normalises a user-entered base URL into the chat-completions endpoint. */
export function resolveEndpoint(baseUrl: string): string {
  const root = baseRoot(baseUrl);
  if (/\/chat\/completions$/.test(baseUrl.trim())) return baseUrl.trim();
  return `${root}/chat/completions`;
}

/** Normalises a user-entered base URL into the models endpoint. */
export function resolveModelsEndpoint(baseUrl: string): string {
  return `${baseRoot(baseUrl)}/models`;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  /**
   * The text being rewritten. It decides whether thinking tags in the response
   * belong to the model or to the dataset, so it must be supplied whenever the
   * call rewrites existing content.
   */
  sourceText?: string;
}

export interface ChatResult {
  /** Cleaned text, ready to be written into the dataset. */
  content: string;
  /**
   * True when the provider stopped because the token ceiling was reached.
   *
   * A truncated rewrite is shorter than its input, so applying it would silently
   * delete part of the sample. Callers must refuse to apply it.
   */
  truncated: boolean;
  /** True when thinking content was removed. */
  hadThinking: boolean;
  /** Why thinking content was or was not removed. */
  thinkingDecision: ThinkingDecision;
  finishReason?: string;
}

/**
 * How aggressively to remove reasoning blocks from a model's output.
 *
 * The hard part is that a reasoning model's own scratchpad and a dataset that
 * legitimately stores chain-of-thought use the *same* markers, so the tags alone
 * cannot say who wrote them. Stripping blindly therefore deletes data the user
 * is trying to clean. The decision is made per item, from the source text.
 *
 *  - `auto`   (default) compares how many blocks the source had with how many
 *             the reply has. A model should not *add* reasoning blocks to
 *             content that already has them, so any surplus is treated as the
 *             model's own and removed from the front; the data's blocks are
 *             preserved. A source with no blocks at all means every block in the
 *             reply is the model's, so all of them go.
 *  - `always` strip every block regardless of the source.
 *  - `leading` strip only a leading block.
 *  - `never`  never strip.
 */
export type ThinkingMode = 'auto' | 'always' | 'leading' | 'never';

/** Why a stripping decision was reached, so the UI can explain itself. */
export type ThinkingDecision =
  | 'stripped-all'
  | 'stripped-leading'
  | 'kept-source-has-tags'
  | 'kept-disabled'
  | 'nothing-to-strip';

export interface StripThinkingOptions {
  mode?: ThinkingMode;
  /** The text being rewritten; decides whether the tags belong to the data. */
  sourceText?: string;
}

export interface StripThinkingResult {
  text: string;
  removed: boolean;
  decision: ThinkingDecision;
}

/**
 * Cuts from the first start tag that has no matching end tag.
 *
 * An unterminated opener means the model never finished thinking; keeping the
 * remainder would write half a scratchpad into the dataset.
 *
 * Only an *unmatched* opener triggers a cut. A plain "opener with no closer
 * later" search would wrongly discard a later, properly paired block, which is
 * exactly the data that must survive.
 */
function cutUnterminated(text: string, startRe: string, endRe: string): string {
  const opener = new RegExp(startRe, 'gi');
  let m: RegExpExecArray | null;
  while ((m = opener.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    if (!new RegExp(endRe, 'i').test(rest)) return text.slice(0, m.index);
  }
  return text;
}

/** Counts reasoning blocks, treating a trailing unterminated opener as one. */
function countBlocks(text: string, startRe: string, endRe: string): number {
  if (!text) return 0;
  const pairRe = new RegExp(`${startRe}[\\s\\S]*?${endRe}`, 'gi');
  const pairs = (text.match(pairRe) ?? []).length;
  const leftover = text.replace(pairRe, '');
  const opens = (leftover.match(new RegExp(startRe, 'gi')) ?? []).length;
  return pairs + opens;
}

/** Removes up to `count` blocks from the very start of the text. */
function stripLeadingBlocks(
  text: string,
  count: number,
  startRe: string,
  endRe: string,
): string {
  let out = text;
  const leading = new RegExp(`^\\s*${startRe}[\\s\\S]*?${endRe}`, 'i');
  for (let i = 0; i < count; i++) {
    if (!leading.test(out)) break;
    out = out.replace(leading, '');
  }
  return out;
}

/**
 * Removes reasoning blocks delimited by the configured tags.
 *
 * The tags are matched literally (escaped), because a closing tag such as
 * `</think>` contains regex metacharacters.
 */
export function stripThinking(
  text: string,
  startTag: string,
  endTag: string,
  opts: StripThinkingOptions = {},
): StripThinkingResult {
  const mode = opts.mode ?? 'auto';
  const start = startTag.trim();
  const end = endTag.trim();

  if (!start || !end) return { text, removed: false, decision: 'kept-disabled' };

  const startRe = escapeRegExp(start);
  const endRe = escapeRegExp(end);
  const source = opts.sourceText ?? '';
  const sourceBlocks = countBlocks(source, startRe, endRe);
  const outputBlocks = countBlocks(text, startRe, endRe);

  if (mode === 'never') return { text, removed: false, decision: 'kept-disabled' };

  if (outputBlocks === 0) return { text, removed: false, decision: 'nothing-to-strip' };

  if (mode === 'always') {
    return {
      text: cutUnterminated(text.replace(new RegExp(`${startRe}[\\s\\S]*?${endRe}`, 'gi'), ''), startRe, endRe),
      removed: true,
      decision: 'stripped-all',
    };
  }

  if (mode === 'leading') {
    const out = cutUnterminated(stripLeadingBlocks(text, 1, startRe, endRe), startRe, endRe);
    return { text: out, removed: true, decision: 'stripped-leading' };
  }

  // auto
  if (sourceBlocks === 0) {
    // The dataset does not use these tags, so every block is the model's.
    return {
      text: cutUnterminated(text.replace(new RegExp(`${startRe}[\\s\\S]*?${endRe}`, 'gi'), ''), startRe, endRe),
      removed: true,
      decision: 'stripped-all',
    };
  }

  const surplus = outputBlocks - sourceBlocks;
  if (surplus <= 0) {
    // No block the model added on its own, so these are the dataset's.
    return { text, removed: false, decision: 'kept-source-has-tags' };
  }

  const out = cutUnterminated(stripLeadingBlocks(text, surplus, startRe, endRe), startRe, endRe);
  return { text: out, removed: true, decision: 'stripped-leading' };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Performs one completion. Throws an Error with a human-readable, Chinese
 * message on failure so the UI can surface it directly in a batch report.
 */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  if (!config.apiKey.trim()) throw new Error('未配置 API Key');

  const endpoint = resolveEndpoint(config.baseUrl);
  const extra = parseExtraBody(config.extraBody);

  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...extra,
  };

  const json = await postJson(endpoint, config.apiKey, body, opts);

  const raw = extractContent(json);
  if (raw === null) {
    throw new Error(`响应缺少 choices[0].message.content`);
  }

  const thinking = stripThinking(raw, config.thinkingStartTag, config.thinkingEndTag, {
    mode: effectiveThinkingMode(config),
    sourceText: opts.sourceText,
  });
  const cleaned = stripWrapper(thinking.text);
  const finishReason = extractFinishReason(json);

  return {
    content: cleaned,
    truncated: finishReason === 'length',
    hadThinking: thinking.removed,
    thinkingDecision: thinking.decision,
    finishReason,
  };
}

/** Fetches the model identifiers the endpoint advertises. */
export async function listModels(
  config: Pick<LlmConfig, 'baseUrl' | 'apiKey'>,
  opts: ChatOptions = {},
): Promise<string[]> {
  const endpoint = resolveModelsEndpoint(config.baseUrl);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'GET',
      headers: config.apiKey.trim()
        ? { Authorization: `Bearer ${config.apiKey.trim()}` }
        : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(`获取模型列表失败: ${(err as Error).message}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`获取模型列表 HTTP ${res.status}: ${truncate(raw, 200)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`模型列表响应不是 JSON: ${truncate(raw, 200)}`);
  }

  return parseModelIds(json);
}

/**
 * Reads model ids from the `/models` payload.
 *
 * Accepts both the OpenAI shape (`{data: [{id}]}`) and a bare array, because
 * self-hosted gateways vary. Entries without a usable id are skipped.
 */
export function parseModelIds(json: unknown): string[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)
      ? ((json as { data: unknown[] }).data)
      : [];

  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry.trim()) ids.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === 'object') {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    }
  }
  // De-duplicate while keeping the server's ordering.
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

function parseExtraBody(extraBody: string): Record<string, unknown> {
  if (!extraBody.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(extraBody);
  } catch (err) {
    throw new Error(`附加请求体不是合法 JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('附加请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

async function postJson(
  endpoint: string,
  apiKey: string,
  body: unknown,
  opts: ChatOptions,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(raw, 300)}`);

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`响应不是 JSON: ${truncate(raw, 200)}`);
  }
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

function extractFinishReason(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as Record<string, unknown>).finish_reason;
  return typeof reason === 'string' ? reason : undefined;
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

/** Characters of each non-target turn included as context. */
const CONTEXT_TURN_LIMIT = 1200;

/**
 * Builds the message list for a single-turn rewrite.
 *
 * The target is sent in full and restated separately from the surrounding
 * context. Two previous behaviours corrupted data:
 *
 *  - the target was truncated along with the context, so a reply longer than the
 *    limit was rewritten from an excerpt and the applied result was silently
 *    shorter than the original;
 *  - the prompt claimed the marked turn was "the last one" while the marker
 *    sat at an arbitrary index, contradicting the structure it described.
 *
 * The instruction is kept separate from the data so a sample cannot easily
 * hijack the instruction channel.
 */
export function buildRewriteMessages(
  config: LlmConfig,
  instruction: string,
  context: { from: string; value: string }[],
  targetIndex: number,
): ChatMessage[] {
  const target = context[targetIndex];
  const messages: ChatMessage[] = [{ role: 'system', content: config.systemPrompt }];

  const contextText = context
    .map((t, i) => {
      // The target is listed by position only. Its full text appears once, in
      // the block below, so a long target is not paid for twice in tokens.
      if (i === targetIndex) return `[${i + 1}] ${t.from}（目标，完整内容见下方）`;
      return `[${i + 1}] ${t.from}: ${truncate(t.value, CONTEXT_TURN_LIMIT)}`;
    })
    .join('\n');

  messages.push({
    role: 'user',
    content: [
      `修改要求：${instruction.trim() || '润色并修正错别字、标点和语病，保持原意。'}`,
      '',
      '对话上下文（仅供理解语境；标记为「（目标）」的那一条才是要改的）：',
      contextText,
      '',
      `下面是需要你修改并输出的完整内容（第 ${targetIndex + 1} 条，角色 ${target?.from ?? 'unknown'}）：`,
      '<<<<<<< 需要修改的内容开始',
      target?.value ?? '',
      '>>>>>>> 需要修改的内容结束',
      '',
      '请只输出修改后的这一条正文，不要输出上下文中的其他内容，不要输出思考过程。',
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
