import { createHash } from './hash';
import type { Dataset, Sample, Turn } from '../types';

/**
 * Parsing and serialising of ShareGPT-style dataset records.
 *
 * Tolerant on input (a malformed line is reported and skipped, never fatal),
 * strict on output (every emitted record is re-validated before it is written).
 */

const FINGERPRINT_KEY = '_input_fingerprint';

/** Role aliases seen in real ShareGPT exports, normalised to canonical names. */
const ROLE_ALIASES: Record<string, string> = {
  human: 'human',
  user: 'human',
  prompt: 'human',
  gpt: 'gpt',
  assistant: 'gpt',
  ai: 'gpt',
  bot: 'gpt',
  chatgpt: 'gpt',
  system: 'system',
  tool: 'tool',
  function: 'function',
  observation: 'tool',
};

export interface ParseResult {
  samples: Sample[];
  warnings: string[];
}

/** Detects whether text is a JSON array/object dump or newline-delimited JSON. */
export function detectKind(text: string): 'single' | 'jsonl' {
  const trimmed = text.trimStart();
  // A file starting with [ or { could still be JSONL in theory, but a leading
  // bracket with pretty-printing is overwhelmingly a single JSON document.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.trimStart().startsWith('[') || firstLine.trimStart().startsWith('{')) {
    // Count top-level lines that are themselves complete JSON values.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length > 1) {
      let parseable = 0;
      for (const line of lines.slice(0, 5)) {
        try {
          JSON.parse(line);
          parseable++;
        } catch {
          /* not a standalone JSON value */
        }
      }
      if (parseable >= Math.min(2, lines.length)) return 'jsonl';
    }
    // A single line that parses as an array of objects is still a JSON array.
    return 'single';
  }
  return 'jsonl';
}

/** Normalises a raw role string. Unknown roles are kept as-is, lower-cased. */
export function normaliseRole(raw: unknown): string {
  if (typeof raw !== 'string') return 'human';
  const key = raw.trim().toLowerCase();
  return ROLE_ALIASES[key] ?? key;
}

/**
 * Normalises one raw turn. Accepts `{from,value}` and the common variant
 * field names so that slightly-off exports still load.
 */
function coerceTurn(raw: unknown): Turn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const roleRaw =
    r.from ?? r.role ?? r.speaker ?? r.author ?? r.sender ?? undefined;
  const valueRaw =
    r.value ?? r.content ?? r.text ?? r.message ?? r.utterance ?? undefined;

  if (valueRaw === undefined) return null;

  let value: string;
  if (typeof valueRaw === 'string') {
    value = valueRaw;
  } else if (Array.isArray(valueRaw)) {
    // Some exports store content blocks; flatten the text parts.
    value = valueRaw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          return typeof p.text === 'string' ? p.text : '';
        }
        return '';
      })
      .join('');
  } else {
    value = JSON.stringify(valueRaw);
  }

  return { from: normaliseRole(roleRaw), value };
}

/**
 * Coerces one raw record into a Sample.
 * Returns null (with a reason) when the record has no usable conversations.
 */
export function coerceSample(
  raw: unknown,
  sourceId: string,
  sourceLine: number,
): { sample: Sample } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `第 ${sourceLine} 条不是 JSON 对象` };
  }
  const r = raw as Record<string, unknown>;

  let rawTurns: unknown = r.conversations ?? r.conversation ?? r.messages ?? r.turns;
  if (!rawTurns) {
    return { error: `第 ${sourceLine} 条缺少 conversations 字段` };
  }
  if (!Array.isArray(rawTurns)) {
    return { error: `第 ${sourceLine} 条的 conversations 不是数组` };
  }

  const turns: Turn[] = [];
  for (const t of rawTurns) {
    const turn = coerceTurn(t);
    if (turn) turns.push(turn);
  }
  if (turns.length === 0) {
    return { error: `第 ${sourceLine} 条的 conversations 为空或无法解析` };
  }

  // Preserve every other top-level key verbatim.
  const extra: Record<string, unknown> = {};
  let fingerprint: string | undefined;
  for (const [k, v] of Object.entries(r)) {
    if (k === 'conversations' || k === 'conversation' || k === 'messages' || k === 'turns') continue;
    if (k === FINGERPRINT_KEY) {
      fingerprint = typeof v === 'string' ? v : JSON.stringify(v);
      continue;
    }
    extra[k] = v;
  }

  return {
    sample: {
      id: `${sourceId}:${sourceLine}:${hashSample(raw)}`,
      conversations: turns,
      fingerprint,
      extra,
      sourceId,
      sourceLine,
    },
  };
}

function hashSample(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? '';
  } catch {
    text = String(raw);
  }
  return createHash(text).slice(0, 8);
}

/**
 * Parses an entire dataset file.
 * @param text raw file contents
 * @param sourceId id of the owning dataset
 * @param declaredKind when known from the file extension, avoids re-detection
 */
export function parseDataset(
  text: string,
  sourceId: string,
  declaredKind?: 'single' | 'jsonl',
): ParseResult {
  const samples: Sample[] = [];
  const warnings: string[] = [];
  const kind = declaredKind ?? detectKind(text);

  if (kind === 'single') {
    let doc: unknown;
    try {
      doc = JSON.parse(stripBom(text));
    } catch (err) {
      return { samples: [], warnings: [`JSON 解析失败: ${(err as Error).message}`] };
    }
    // A single file may hold one object or an array of objects.
    const records = Array.isArray(doc) ? doc : [doc];
    records.forEach((rec, i) => {
      const res = coerceSample(rec, sourceId, i + 1);
      if ('sample' in res) samples.push(res.sample);
      else warnings.push(res.error);
    });
    return { samples, warnings };
  }

  const lines = stripBom(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.trim().length === 0) return;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      warnings.push(`第 ${lineNo} 行 JSON 解析失败: ${(err as Error).message}`);
      return;
    }
    const res = coerceSample(rec, sourceId, lineNo);
    if ('sample' in res) samples.push(res.sample);
    else warnings.push(res.error);
  });

  return { samples, warnings };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Serialises one sample back to its on-disk record shape.
 *
 * Key order matches the upstream producer (`conversations`, then
 * `_input_fingerprint`, then any extra keys) so that re-saved files diff
 * cleanly against the originals.
 */
export function serialiseSample(sample: {
  conversations: Turn[];
  fingerprint?: string;
  extra: Record<string, unknown>;
}): string {
  const out: Record<string, unknown> = {
    conversations: sample.conversations.map((t) => ({ from: t.from, value: t.value })),
  };
  if (sample.fingerprint !== undefined) out[FINGERPRINT_KEY] = sample.fingerprint;
  for (const [k, v] of Object.entries(sample.extra)) {
    if (k === 'conversations' || k === FINGERPRINT_KEY) continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}

/** Validates that every sample survives a round-trip before we write a file. */
export function validateForExport(samples: Sample[]): string[] {
  const problems: string[] = [];
  samples.forEach((s, i) => {
    if (s.conversations.length === 0) {
      problems.push(`第 ${i + 1} 条（源第 ${s.sourceLine} 行）没有对话内容`);
      return;
    }
    const bad = s.conversations.findIndex(
      (t) => typeof t.value !== 'string' || typeof t.from !== 'string',
    );
    if (bad >= 0) problems.push(`第 ${i + 1} 条的第 ${bad + 1} 轮字段类型非法`);
  });
  return problems;
}

/** Builds the full JSONL payload for export. */
export function buildJsonl(samples: Sample[]): string {
  return samples.map((s) => serialiseSample(s)).join('\n') + '\n';
}

export function makeDataset(name: string, uri: string | undefined, kind: 'single' | 'jsonl'): Dataset {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    uri,
    kind,
    samples: [],
    warnings: [],
  };
}
