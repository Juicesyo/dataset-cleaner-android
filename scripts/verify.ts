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
import {
  buildRewriteMessages,
  DEFAULT_CONFIG,
  parseModelIds,
  resolveEndpoint,
  resolveModelsEndpoint,
  stripThinking,
  stripWrapper,
} from '../src/lib/llm.ts';

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

/* --------------------------------------------------- reasoning models */

console.log('\n[8] 思考模型标签剥离');

const T = (s: string) => stripThinking(s, '<think>', '</think>');
const T2 = (s: string) => stripThinking(s, '<thinking>', '</thinking>');

check('剥离成对标签', T('<think>想一下</think>答案').text === '答案');
check('标记为已剥离', T('<think>想一下</think>答案').removed === true);
check(
  '剥离多个思考块',
  T('<think>a</think>一<think>b</think>二').text === '一二',
  JSON.stringify(T('<think>a</think>一<think>b</think>二').text),
);
check('大小写不敏感', T('<THINK>x</THINK>答案').text === '答案');
// `stripThinking` deliberately does not trim; `stripWrapper` does that. The
// composed pipeline is what the app actually applies.
check(
  '思考内容跨多行（剥离后交由 stripWrapper 收尾）',
  T('<think>\n第一行\n第二行\n</think>\n\n答案').text.trim() === '答案',
  JSON.stringify(T('<think>\n第一行\n第二行\n</think>\n\n答案').text),
);
check(
  '完整流水线输出干净结果',
  stripWrapper(T('<think>\n第一行\n</think>\n\n答案').text) === '答案',
  JSON.stringify(stripWrapper(T('<think>\n第一行\n</think>\n\n答案').text)),
);
check('无标签时原样返回', T('普通回复').text === '普通回复');
check('无标签时不标记为已剥离', T('普通回复').removed === false);
check(
  '未闭合标签时丢弃其后全部内容',
  T('<think>没写完就断了，答案也没给').text.trim() === '',
  JSON.stringify(T('<think>没写完就断了，答案也没给').text),
);
check(
  '未闭合标签标记为已剥离',
  T('<think>断了').removed === true,
);
check('自定义标签生效', T2('<thinking>x</thinking>答案').text === '答案');
check('标签不匹配时不剥离', T('<thinking>x</thinking>答案').text === '<thinking>x</thinking>答案');
check(
  '标签为空时不做任何处理',
  stripThinking('<think>x</think>y', '', '').text === '<think>x</think>y',
);
check(
  '标签含正则元字符也安全',
  stripThinking('a<b>(c)</b>ok', '<b>', '</b>').text === 'aok',
);
check(
  '正文中的代码块不受影响',
  T('<think>x</think>看这段:\n```js\ny\n```').text === '看这段:\n```js\ny\n```',
);

/* ------------------------------------------------------- model listing */

console.log('\n[9] 模型列表解析');

eq('补全 /models', resolveModelsEndpoint('https://api.openai.com/v1'),
  'https://api.openai.com/v1/models');
eq('从 chat 路径推导', resolveModelsEndpoint('https://x.com/v1/chat/completions'),
  'https://x.com/v1/models');
eq('解析 OpenAI 形式', parseModelIds({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
eq('解析裸数组形式', parseModelIds(['m2', 'm1']), ['m1', 'm2']);
eq('去重', parseModelIds(['a', 'a', 'b']), ['a', 'b']);
eq('跳过无 id 的条目', parseModelIds({ data: [{ id: 'ok' }, { object: 'x' }, null, 5] }), ['ok']);
eq('空响应返回空数组', parseModelIds({}), []);
eq('非对象输入返回空数组', parseModelIds('nope' as unknown), []);

/* --------------------------------------------- rewrite prompt integrity */

console.log('\n[10] 改写提示词完整性');

const conversation = [
  { from: 'human', value: '问题' },
  { from: 'gpt', value: 'X'.repeat(5000) },
  { from: 'human', value: '追问' },
];

// Index 1 is deliberately NOT the last turn.
const msgs = buildRewriteMessages(DEFAULT_CONFIG, '润色', conversation, 1);
const prompt = msgs.map((m) => m.content).join('\n');

check(
  '目标原文完整进入提示词（未被截断）',
  prompt.includes('X'.repeat(5000)),
  `目标长度 5000，提示词中是否含完整串: ${prompt.includes('X'.repeat(5000))}`,
);
check(
  '目标被单独复述一遍',
  prompt.includes('需要修改的内容开始') && prompt.includes('需要修改的内容结束'),
);
check(
  '目标原文只出现一次（不重复占用 token）',
  prompt.split('X'.repeat(5000)).length - 1 === 1,
  `出现 ${prompt.split('X'.repeat(5000)).length - 1} 次`,
);
// Directly verify the truncation asymmetry rather than inferring it from a
// total-length heuristic, which is brittle against prompt wording changes.
const longContext = [
  { from: 'human', value: 'Y'.repeat(5000) },
  { from: 'gpt', value: '短目标' },
];
const p2 = buildRewriteMessages(DEFAULT_CONFIG, '', longContext, 1)
  .map((m) => m.content)
  .join('\n');
check('非目标轮次被截断（不整段送入）', !p2.includes('Y'.repeat(5000)));
check('非目标轮次保留开头部分', p2.includes('Y'.repeat(1200)), '应保留前 1200 字符');
check('非目标轮次确为 1200 字符', p2.includes('Y'.repeat(1200)) && !p2.includes('Y'.repeat(1201)));
check(
  '标记与说明一致：目标位置列出但不重复正文',
  prompt.includes('[2] gpt（目标，完整内容见下方）'),
  prompt.slice(prompt.indexOf('对话上下文'), prompt.indexOf('对话上下文') + 200),
);
check(
  '不再声称目标一定是最后一条',
  !prompt.includes('最后标记的一条'),
);
check(
  '明确指出要输出第几条',
  prompt.includes('第 2 条'),
);
check(
  '系统提示词来自配置',
  msgs[0].role === 'system' && msgs[0].content === DEFAULT_CONFIG.systemPrompt,
);
check(
  '保留默认思考标签',
  DEFAULT_CONFIG.thinkingStartTag === '<think>' && DEFAULT_CONFIG.thinkingEndTag === '</think>',
);
check(
  '留空要求时使用默认润色指令',
  buildRewriteMessages(DEFAULT_CONFIG, '   ', conversation, 0)[1].content.includes('润色'),
);

/* ------------------------------------- thinking tags vs. dataset content */

// A dataset can legitimately store chain-of-thought using the very same markers
// the model uses for its own reasoning, so blind stripping deleted that data.
console.log('\n[11] 思考标签与数据自带思维链的冲突');

{
  const S = '<think>';
  const E = '</think>';
  const auto = (out: string, source: string) =>
    stripThinking(out, S, E, { mode: 'auto', sourceText: source });

  // 1. A faithful reproduction of reasoning data must survive untouched.
  const src1 = `${S}\n数据自带思考\n${E}\n最终答案。`;
  const faithful = `${S}\n数据自带思考（已润色）\n${E}\n最终答案在这里。`;
  const r1 = auto(faithful, src1);
  check('不删除数据自带的思维链', r1.text.includes(S) && r1.text.includes(E), r1.text);
  check('决策为保留', r1.decision === 'kept-source-has-tags', r1.decision);
  check('未标记为已剥离', r1.removed === false);

  // 2. A model that prepends its own reasoning adds one extra block.
  const withPreamble = `${S}\n我自己的思考\n${E}\n${S}\n数据自带思考（已润色）\n${E}\n最终答案在这里。`;
  const r2 = auto(withPreamble, src1);
  check('剥离模型新增的思考段', !r2.text.includes('我自己的思考'), r2.text);
  check('保留数据自带的那段', r2.text.includes('数据自带思考（已润色）'), r2.text);
  check('决策为只剥离开头', r2.decision === 'stripped-leading', r2.decision);

  // 3. The data's block sits mid-body; only the leading one is the model's.
  const src3 = `前言。\n\n${S}\n正文中的思考\n${E}\n结尾。`;
  const out3 = `${S}\n模型自己的思考\n${E}\n${src3}`;
  const r3 = auto(out3, src3);
  check('剥离开头的模型思考', !r3.text.includes('模型自己的思考'), r3.text);
  check('保留正文中段的思维链', r3.text.includes('正文中的思考'), r3.text);

  // 4. Plain data: every block must be the model's.
  const r4 = auto(`${S}\n模型思考\n${E}\n改写后的回复。`, '普通回复。');
  check('普通数据仍剥离全部', r4.text.trim() === '改写后的回复。', JSON.stringify(r4.text));

  // 5. Explicit modes override the heuristic.
  const src5 = `${S}\n数据思考\n${E}\n答案`;
  const out5 = `${S}\n模型思考\n${E}\n${S}\n数据思考\n${E}\n答案`;
  check(
    'always 仍剥离全部',
    !stripThinking(out5, S, E, { mode: 'always', sourceText: src5 }).text.includes(S),
  );
  check('never 完全不剥离', stripThinking(out5, S, E, { mode: 'never', sourceText: src5 }).text === out5);
  const lead5 = stripThinking(out5, S, E, { mode: 'leading', sourceText: src5 });
  check(
    'leading 只剥离开头一段',
    !lead5.text.includes('模型思考') && lead5.text.includes('数据思考'),
    lead5.text,
  );

  // 6. Several data blocks must all survive when the model adds none.
  const src6 = `${S}\n一\n${E}中间${S}\n二\n${E}`;
  check('多块数据在无新增时全部保留', auto(src6, src6).text === src6);

  // 7. A surplus of two is removed from the front, not from the middle.
  const src7 = `${S}\n数据\n${E}答案`;
  const out7 = `${S}\n模型一\n${E}\n${S}\n模型二\n${E}\n${S}\n数据\n${E}答案`;
  const r7 = auto(out7, src7);
  check(
    '多余两块时从头剥离两块',
    !r7.text.includes('模型一') && !r7.text.includes('模型二') && r7.text.includes('数据'),
    r7.text,
  );

  // 8. An unterminated opener still cuts, without eating an earlier paired block.
  check('未闭合时截断到结尾', auto(`${S}没写完`, '普通回复').text.trim() === '');
  check(
    '未闭合截断不影响此前的成对块',
    auto(`${S}数据\n${E}答案${S}又没写完`, '普通回复').text.includes('答案'),
    JSON.stringify(auto(`${S}数据\n${E}答案${S}又没写完`, '普通回复').text),
  );
}

/* ----------------------------------------------------------------- done */

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}: ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
