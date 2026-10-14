/**
 * Standalone verification of the data layer.
 *
 * Run with: node --experimental-strip-types scripts/verify.ts
 * (Node 22+ strips the type annotations; no bundler needed.)
 *
 * Covers the parts that silently corrupt data if wrong: ShareGPT round-tripping
 * including `_input_fingerprint`, JSONL vs single-JSON detection, malformed-line
 * tolerance, and the diff engine's colour segmentation.
 */

import {
  buildJsonl,
  coerceSample,
  detectKind,
  parseDataset,
  serialiseSample,
  validateForExport,
} from '../src/lib/sharegpt.ts';
import { diffText } from '../src/lib/diff.ts';
import { resolveEndpoint, stripWrapper } from '../src/lib/llm.ts';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `expected ${b}, got ${a}`);
}

/* -------------------------------------------------- ShareGPT round-trip */

console.log('\n[1] ShareGPT 往返（含 _input_fingerprint 保留）');

const record = {
  conversations: [
    { from: 'human', value: '你好' },
    { from: 'gpt', value: '你好！有什么可以帮你的？' },
  ],
  _input_fingerprint: 'abc123def456',
};

const parsed = parseDataset(JSON.stringify(record), 'ds1', 'single');
check('单条 JSON 解析出 1 条', parsed.samples.length === 1);
check('无警告', parsed.warnings.length === 0, parsed.warnings.join('; '));

const s0 = parsed.samples[0];
check('fingerprint 被捕获', s0.fingerprint === 'abc123def456');
check('轮次数为 2', s0.conversations.length === 2);

const roundTripped = JSON.parse(serialiseSample(s0));
eq('conversations 完全一致', roundTripped.conversations, record.conversations);
check(
  '_input_fingerprint 原样保留',
  roundTripped._input_fingerprint === 'abc123def456',
);
eq(
  '键顺序与原始一致',
  Object.keys(roundTripped),
  ['conversations', '_input_fingerprint'],
);

/* ---------------------------------------------------- field variants */

console.log('\n[2] 字段变体容错');

const variant = coerceSample(
  {
    conversations: [
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ],
  },
  'ds1',
  1,
);
check('role/content 变体被接受', 'sample' in variant);
if ('sample' in variant) {
  check('user 归一化为 human', variant.sample.conversations[0].from === 'human');
  check('assistant 归一化为 gpt', variant.sample.conversations[1].from === 'gpt');
}

const missing = coerceSample({ foo: 1 }, 'ds1', 7);
check('缺少 conversations 被拒绝', 'error' in missing);
if ('error' in missing) {
  check('错误信息含行号', missing.error.includes('7'), missing.error);
}

/* ------------------------------------------------------- JSONL handling */

console.log('\n[3] JSONL 与损坏行容错');

const jsonl = [
  JSON.stringify(record),
  '',
  '{"conversations": [{"from":"human","value":"二"}]}',
  '{ this is not json',
  JSON.stringify({ conversations: [{ from: 'gpt', value: '三' }], extra_field: 42 }),
].join('\n');

const jsonlResult = parseDataset(jsonl, 'ds2', 'jsonl');
check('3 条有效样本', jsonlResult.samples.length === 3, String(jsonlResult.samples.length));
check('1 条警告（坏行）', jsonlResult.warnings.length === 1, jsonlResult.warnings.join('; '));
check(
  '第 4 行的警告提到行号 4',
  jsonlResult.warnings[0].includes('第 4 行'),
  jsonlResult.warnings[0],
);
check(
  '保留未知顶层字段',
  jsonlResult.samples[2].extra.extra_field === 42,
);

const out = buildJsonl(jsonlResult.samples);
check('JSONL 输出以换行结尾', out.endsWith('\n'));
check('输出行数正确', out.trim().split('\n').length === 3);

/* --------------------------------------------------------- kind detect */

console.log('\n[4] 格式自动识别');

check('单条对象识别为 single', detectKind(JSON.stringify(record)) === 'single');
check(
  '多行 JSONL 识别为 jsonl',
  detectKind([JSON.stringify(record), JSON.stringify(record)].join('\n')) === 'jsonl',
);
check(
  'JSON 数组识别为 single',
  detectKind(JSON.stringify([record, record])) === 'single',
);
check(
  'BOM 不影响解析',
  parseDataset('\uFEFF' + JSON.stringify(record), 'ds3', 'single').samples.length === 1,
);

/* ------------------------------------------------------------- validate */

console.log('\n[5] 导出前校验');

const bad = [
  {
    id: 'x',
    conversations: [{ from: 'human', value: 'hi' }],
    extra: {},
    sourceId: 'd',
    sourceLine: 1,
  },
  { id: 'y', conversations: [], extra: {}, sourceId: 'd', sourceLine: 2 },
];
const problems = validateForExport(bad);
check('检测到空样本', problems.length === 1, problems.join('; '));
check('问题信息含序号', problems[0].includes('第 2 条'), problems[0]);

/* ----------------------------------------------------------------- diff */

console.log('\n[6] 差异高亮');

const d1 = diffText('今天天气很好', '今天天气非常好');
// The edit is "很" -> "非常": a shared prefix, a replacement, a shared suffix.
check('识别出共同前缀', d1[0].kind === 'same' && d1[0].text === '今天天气');
check('识别出共同后缀', d1[d1.length - 1].kind === 'same' && d1[d1.length - 1].text === '好');
check('替换部分有删除段', d1.some((s) => s.kind === 'del' && s.text === '很'));
check('替换部分有新增段', d1.some((s) => s.kind === 'add' && s.text === '非常'));
check(
  '重组后等于新文本',
  d1.filter((s) => s.kind !== 'del').map((s) => s.text).join('') === '今天天气非常好',
);
check(
  '重组后等于旧文本',
  d1.filter((s) => s.kind !== 'add').map((s) => s.text).join('') === '今天天气很好',
);

const d2 = diffText('same', 'same');
check('无变化时只有一个 same 段', d2.length === 1 && d2[0].kind === 'same');

const d3 = diffText('', 'new');
check('空到有内容为纯新增', d3.every((s) => s.kind === 'add'));

const d4 = diffText('old long text here', 'old long text there');
check('替换场景同时有 add 和 del',
  d4.some((s) => s.kind === 'add') && d4.some((s) => s.kind === 'del'));
check(
  '保留相同的前缀',
  d4[0].kind === 'same' && d4[0].text.startsWith('old long text'),
  JSON.stringify(d4[0]),
);

// Large input must not blow the DP table (forces the coarse fallback).
const big1 = 'a'.repeat(1500) + 'X';
const big2 = 'a'.repeat(1500) + 'Y';
const d5 = diffText(big1, big2);
check('大文本不抛错且重建正确',
  d5.filter((s) => s.kind !== 'del').map((s) => s.text).join('') === big2);

// Property test: for arbitrary edits, the delete-free projection must equal the
// new text and the add-free projection must equal the old text. This is the
// invariant the editor relies on to colour the right characters.
console.log('\n[6b] 差异重建不变量（随机样本）');
let invariantFailures = 0;
const alphabet = ['中', '文', 'a', 'b', ' ', '，', '1', 'Z', '\n'];
for (let i = 0; i < 400; i++) {
  const len = 1 + Math.floor(Math.random() * 40);
  let oldText = '';
  for (let j = 0; j < len; j++) {
    oldText += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  // Derive the new text by applying a few random edits.
  let newText = oldText;
  const edits = Math.floor(Math.random() * 4);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(Math.random() * (newText.length + 1));
    const op = Math.random();
    if (op < 0.4) {
      newText = newText.slice(0, at) + alphabet[Math.floor(Math.random() * alphabet.length)] + newText.slice(at);
    } else if (op < 0.7 && newText.length > 0) {
      newText = newText.slice(0, at) + newText.slice(at + 1);
    } else {
      newText = newText.slice(0, at) + alphabet[Math.floor(Math.random() * alphabet.length)] + newText.slice(at);
    }
  }
  const segs = diffText(oldText, newText);
  const rebuiltNew = segs.filter((s) => s.kind !== 'del').map((s) => s.text).join('');
  const rebuiltOld = segs.filter((s) => s.kind !== 'add').map((s) => s.text).join('');
  if (rebuiltNew !== newText || rebuiltOld !== oldText) {
    invariantFailures++;
    if (invariantFailures === 1) {
      console.log(`    反例: old=${JSON.stringify(oldText)} new=${JSON.stringify(newText)}`);
    }
  }
}
check(`400 组随机编辑全部可精确重建`, invariantFailures === 0, `${invariantFailures} 组失败`);

/* ------------------------------------------------------------------ llm */

console.log('\n[7] LLM 辅助函数');

eq('baseUrl 补全 endpoint', resolveEndpoint('https://api.openai.com/v1'),
  'https://api.openai.com/v1/chat/completions');
eq('已含路径不重复拼接',
  resolveEndpoint('https://api.deepseek.com/v1/chat/completions'),
  'https://api.deepseek.com/v1/chat/completions');
eq('去除尾部斜杠', resolveEndpoint('https://x.com/v1///'),
  'https://x.com/v1/chat/completions');

eq('剥离代码块围栏', stripWrapper('```\nhello\n```'), 'hello');
eq('剥离带语言标记的围栏', stripWrapper('```text\nhello\n```'), 'hello');
eq('剥离外层引号', stripWrapper('"hello"'), 'hello');
eq('不动正文中的代码块', stripWrapper('看这段:\n```js\nx\n```\n结束'), '看这段:\n```js\nx\n```\n结束');

/* ----------------------------------------------------------------- done */

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}: ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
