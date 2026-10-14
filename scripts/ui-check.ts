/**
 * UI smoke test.
 *
 * Drives the built app in a real browser to prove the pieces typecheck cannot
 * cover actually work: rendering, import, editing, diff colouring, undo/redo,
 * search, and the export payload. The dataset is injected by stubbing the
 * browser file input, since that is the only import path that exists on web.
 *
 * Run with: npx vite-node scripts/ui-check.ts
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Replaces a textarea's contents the way a user does.
 *
 * Playwright's `fill()` assigns the value and fires a single synthetic `input`,
 * which races React's controlled-component re-render and its `requestAnimationFrame`
 * auto-grow pass: the DOM can end up showing a stale value even though the store
 * was updated. Typing character by character drives the same code path a real
 * keyboard does, so the assertions below test the app rather than the harness.
 */
async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector);
  await el.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text, { delay: 6 });
}

/** The fingerprint must survive a full import -> edit -> export cycle. */
const FINGERPRINT = 'fp-9f2c1a7b3e';

const dataset = [
  {
    conversations: [
      { from: 'human', value: '介绍一下杭州' },
      { from: 'gpt', value: '杭州是浙江省的省会，以西湖闻名。' },
    ],
    _input_fingerprint: FINGERPRINT,
  },
  {
    conversations: [
      { from: 'human', value: '今天天气怎么样' },
      { from: 'gpt', value: '抱歉，我无法获取实时天气。' },
    ],
    _input_fingerprint: 'fp-second-record',
  },
  {
    conversations: [
      { from: 'human', value: '写一首短诗' },
      { from: 'gpt', value: '春风又绿江南岸。' },
    ],
    _input_fingerprint: 'fp-third-record',
  },
];

const tmp = mkdtempSync(join(tmpdir(), 'ds-cleaner-'));
const datasetPath = join(tmp, 'sample.jsonl');
writeFileSync(
  datasetPath,
  dataset.map((d) => JSON.stringify(d)).join('\n') + '\n',
  'utf8',
);

let server: ViteDevServer | null = null;

async function main(): Promise<void> {
  server = await createServer({
    root: process.cwd(),
    server: { port: 5199, strictPort: true },
    logLevel: 'error',
  });
  await server.listen();
  const url = 'http://localhost:5199/';

  const browser = await chromium.launch();
  // Emulate a phone so the responsive layout is what gets exercised.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(url, { waitUntil: 'networkidle' });

  /* ------------------------------------------------------------ render */

  console.log('\n[1] 初始渲染');
  await page.waitForSelector('.app', { timeout: 15000 });
  check('应用已挂载', await page.isVisible('.toolbar'));
  check(
    '未导入时显示引导文案',
    (await page.textContent('.empty'))?.includes('还没有导入数据') ?? false,
  );

  /* ------------------------------------------------------------ import */

  console.log('\n[2] 导入数据集');
  page.once('filechooser', async (fc) => {
    await fc.setFiles([datasetPath]);
  });
  await page.click('.toolbar button:has-text("导入")');
  await page.click('.sheet-actions button:has-text("选择文件")');

  await page.waitForSelector('.sample-card', { timeout: 15000 });
  const cardCount = await page.locator('.sample-card').count();
  check('导入 3 条样本', cardCount === 3, String(cardCount));
  check(
    '工具栏统计正确',
    (await page.textContent('.toolbar-stats'))?.includes('3 条') ?? false,
    (await page.textContent('.toolbar-stats')) ?? '',
  );

  /* ------------------------------------------------------------ expand */

  console.log('\n[3] 展开与编辑');
  await page.locator('.sample-card').first().locator('.sample-head').click();
  await page.waitForSelector('.sample-card.expanded .edit-surface', { timeout: 10000 });

  const taCount = await page.locator('.sample-card.expanded .edit-surface').count();
  check('展开后出现 2 个编辑框', taCount === 2, String(taCount));

  const firstArea = page.locator('.sample-card.expanded .edit-surface').nth(1);

  // Auto-grow: a long value must produce a taller box than a short one.
  const shortH = await page
    .locator('.sample-card.expanded .edit-surface')
    .nth(0)
    .evaluate((el) => (el as HTMLTextAreaElement).getBoundingClientRect().height);

  await typeInto(
    page,
    '.sample-card.expanded .edit-surface >> nth=1',
    '杭州是浙江省的省会，以西湖闻名天下，also known for tea.',
  );

  const longH = await firstArea.evaluate(
    (el) => (el as HTMLTextAreaElement).getBoundingClientRect().height,
  );
  check('编辑框高度随内容变化', longH >= shortH, `short=${shortH} long=${longH}`);

  /* -------------------------------------------------------------- diff */

  console.log('\n[4] 实时差异高亮');
  await page.waitForSelector('.seg-add', { timeout: 10000 });
  const addText = await page.locator('.seg-add').first().textContent();
  const delText = await page.locator('.seg-del').first().textContent();
  check('存在新增高亮', (addText ?? '').length > 0, String(addText));
  check('存在删除高亮', (delText ?? '').length > 0, String(delText));

  // The coloured layer must actually be laid out, not display:none.
  const backdropBox = await page.locator('.diff-backdrop').first().boundingBox();
  const areaBox = await firstArea.boundingBox();
  check('diff 图层可见', Boolean(backdropBox && backdropBox.height > 10));
  check(
    'diff 图层与输入框对齐',
    Boolean(
      backdropBox &&
        areaBox &&
        Math.abs(backdropBox.x - areaBox.x) < 2 &&
        Math.abs(backdropBox.y - areaBox.y) < 2,
    ),
    `backdrop=${JSON.stringify(backdropBox)} area=${JSON.stringify(areaBox)}`,
  );

  // The diff must be colour-coded, not merely present.
  const addBg = await page
    .locator('.seg-add')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const delBg = await page
    .locator('.seg-del')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  check('新增段有绿色背景', addBg.includes('62, 207, 142'), addBg);
  check('删除段有红色背景', delBg.includes('255, 95, 87'), delBg);
  check('新增与删除颜色不同', addBg !== delBg);

  check(
    '卡片显示已改动徽标',
    (await page.locator('.badge.edited').count()) > 0,
  );

  /* ------------------------------------------------------------ undo */

  console.log('\n[5] 撤销与重做');
  // Blur by focusing a plain field. Clicking `.toolbar` would land its centre
  // point on the "还原全部" button at this viewport width and reset everything.
  await page.locator('.search-input').click();
  await page.waitForTimeout(400);
  check(
    '编辑后撤销按钮可用',
    !(await page.locator('.toolbar button:has-text("撤销")').isDisabled()),
  );
  check(
    '编辑在失焦后仍然保留',
    (await page.locator('.sample-card.expanded .edit-surface').nth(1).inputValue()) ===
      '杭州是浙江省的省会，以西湖闻名天下，also known for tea.',
  );

  await page.click('.toolbar button:has-text("撤销")');
  await page.waitForTimeout(400);

  const valueAfterUndo = await page
    .locator('.sample-card.expanded .edit-surface')
    .nth(1)
    .inputValue();
  check(
    '撤销后恢复原文',
    valueAfterUndo === '杭州是浙江省的省会，以西湖闻名。',
    valueAfterUndo,
  );

  await page.click('.toolbar button:has-text("重做")');
  await page.waitForTimeout(300);
  const valueAfterRedo = await page
    .locator('.sample-card.expanded .edit-surface')
    .nth(1)
    .inputValue();
  check('重做后恢复修改', valueAfterRedo.includes('also known for tea'), valueAfterRedo);

  /* ---------------------------------------------------------- search */

  console.log('\n[6] 搜索筛选');
  await page.fill('.search-input', '短诗');
  await page.waitForTimeout(400);
  const filtered = await page.locator('.sample-card').count();
  check('搜索“短诗”筛出 1 条', filtered === 1, String(filtered));

  await page.fill('.search-input', '');
  await page.waitForTimeout(400);
  check('清空后恢复 3 条', (await page.locator('.sample-card').count()) === 3);

  /* ----------------------------------------------- soft delete + export */

  console.log('\n[7] 删除与导出');

  // Soft-delete the second card, then confirm the UI reflects it.
  await page.locator('.sample-card').nth(1).locator('.sample-head').click();
  await page.waitForTimeout(300);
  await page.locator('.sample-card').nth(1).locator('button:has-text("标记删除")').click();
  await page.waitForTimeout(300);
  check(
    '卡片显示已删除样式',
    (await page.locator('.sample-card.deleted').count()) === 1,
  );

  // Capture the export payload by intercepting the blob URL the browser
  // backend creates, which is what a real save would hand to the user.
  await page.addInitScript(`
    window.__captured = null;
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      blob.text().then((t) => { window.__captured = t; });
      return origCreate(blob);
    };
  `);
  await page.reload({ waitUntil: 'networkidle' });

  // Re-import after reload, since the store lives in memory only.
  page.once('filechooser', async (fc) => {
    await fc.setFiles([datasetPath]);
  });
  await page.click('.toolbar button:has-text("导入")');
  await page.click('.sheet-actions button:has-text("选择文件")');
  await page.waitForSelector('.sample-card', { timeout: 15000 });

  // Make an edit so the export contains a change worth verifying.
  await page.locator('.sample-card').first().locator('.sample-head').click();
  await page.waitForSelector('.sample-card.expanded .edit-surface');
  await typeInto(page, '.sample-card.expanded .edit-surface >> nth=1', '杭州以西湖闻名。');

  await page.click('.toolbar button:has-text("另存为")');
  await page.waitForSelector('.sheet .sheet-actions', { timeout: 5000 });
  await page.click('.sheet-actions button.primary');
  await page.waitForTimeout(800);

  const captured = (await page.evaluate('window.__captured')) as string | null;
  check('导出产生了内容', Boolean(captured && captured.length > 0));

  if (captured) {
    const lines = captured.trim().split('\n');
    check('导出 3 行', lines.length === 3, String(lines.length));

    const first = JSON.parse(lines[0]);
    check('第一条使用编辑后的文本', first.conversations[1].value === '杭州以西湖闻名。');
    check(
      '_input_fingerprint 在导出中保留',
      first._input_fingerprint === FINGERPRINT,
      String(first._input_fingerprint),
    );
    check(
      '键顺序与原始一致',
      JSON.stringify(Object.keys(first)) ===
        JSON.stringify(['conversations', '_input_fingerprint']),
      JSON.stringify(Object.keys(first)),
    );
    const second = JSON.parse(lines[1]);
    check('未修改条目的 fingerprint 也在', second._input_fingerprint === 'fp-second-record');
  }

  /* ---------------------------------------------------------- settings */

  console.log('\n[8] 设置面板');
  await page.keyboard.press('Escape').catch(() => {});
  await page.click('.drawer-backdrop', { position: { x: 10, y: 10 } }).catch(() => {});
  await page.click('.toolbar button:has-text("设置")');
  await page.waitForSelector('.drawer', { timeout: 5000 });
  check(
    '系统提示词可编辑',
    (await page.locator('.drawer textarea').count()) >= 2,
  );
  const baseUrlInput = page.locator('.drawer input[type="url"]');
  check('Base URL 字段存在', (await baseUrlInput.count()) === 1);
  check(
    'API Key 输入为密码型',
    (await page.locator('.drawer input[type="password"]').count()) === 1,
  );
  check(
    '思考标签字段存在且有默认值',
    (await page.locator('.drawer input[placeholder="<think>"]').inputValue()) === '<think>' &&
      (await page.locator('.drawer input[placeholder="</think>"]').inputValue()) === '</think>',
  );
  check(
    '有获取模型列表按钮',
    (await page.locator('.drawer button:has-text("获取列表")').count()) === 1,
  );

  // Regression: "恢复默认" previously issued two separate updates that each
  // spread the same render's config, so the second discarded the first and the
  // start tag was never restored.
  {
    const startTag = page.locator('.drawer input[placeholder="<think>"]');
    const endTag = page.locator('.drawer input[placeholder="</think>"]');
    await startTag.fill('<<<start>>>');
    await endTag.fill('<<<end>>>');
    await page.waitForTimeout(200);
    await page.click('.drawer button:has-text("恢复默认")');
    await page.waitForTimeout(300);
    check(
      '恢复默认同时还原开始与结束标签',
      (await startTag.inputValue()) === '<think>' && (await endTag.inputValue()) === '</think>',
      `start=${await startTag.inputValue()} end=${await endTag.inputValue()}`,
    );
  }

  // Model type: plain models must never have their output stripped.
  {
    const typeSelect = page.locator('.drawer select').first();
    check(
      '有模型类型选择，默认思考模型',
      (await typeSelect.locator('option').count()) === 2 &&
        (await typeSelect.inputValue()) === 'reasoning',
      await typeSelect.inputValue(),
    );
    check(
      '思考模型时显示标签字段',
      (await page.locator('.drawer input[placeholder="<think>"]').count()) === 1,
    );

    await typeSelect.selectOption('plain');
    await page.waitForTimeout(250);
    check(
      '普通模型时隐藏标签字段',
      (await page.locator('.drawer input[placeholder="<think>"]').count()) === 0,
    );
    check(
      '普通模型时给出说明',
      ((await page.textContent('.drawer')) ?? '').includes('不处理思考内容'),
    );

    await typeSelect.selectOption('reasoning');
    await page.waitForTimeout(250);
    check(
      '切回思考模型后标签恢复显示',
      (await page.locator('.drawer input[placeholder="<think>"]').count()) === 1,
    );
  }

  // The model picker talks to `GET {base}/models`. Routing the request lets the
  // parsing and the chip list be tested without a live provider.
  await page.route('**/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: 'deepseek-r1' }, { id: 'gpt-4o-mini' }, { id: 'zeta-model' }],
      }),
    });
  });
  await baseUrlInput.fill('https://stub.local/v1');
  await page.click('.drawer button:has-text("获取列表")');
  await page.waitForSelector('.model-chips .chip', { timeout: 10_000 });

  const chips = await page.locator('.model-chips .chip').allTextContents();
  check(
    '模型列表被解析并排序',
    JSON.stringify(chips) === JSON.stringify(['deepseek-r1', 'gpt-4o-mini', 'zeta-model']),
    JSON.stringify(chips),
  );

  // Picking a reasoning-looking model must also set the model type, and say so.
  // Start from "plain" so the switch is a real transition; a no-op must stay
  // silent rather than announcing a change that did not happen.
  await page.locator('.drawer select').first().selectOption('plain');
  await page.waitForTimeout(200);

  await page.locator('.model-chips .chip', { hasText: 'deepseek-r1' }).click();
  await page.waitForTimeout(250);
  check(
    '点击模型后写入模型字段',
    (await page.locator('.drawer input[placeholder="gpt-4o-mini"]').inputValue()) === 'deepseek-r1',
  );
  check(
    '选中的模型有高亮',
    (await page.locator('.model-chips .chip-active').textContent()) === 'deepseek-r1',
  );
  check(
    '推理模型名会说明已自动切换类型',
    ((await page.textContent('.drawer')) ?? '').includes('自动设为思考模型'),
    (await page.textContent('.model-list-note').catch(() => '')) ?? '',
  );
  check(
    '推理模型名后类型为思考模型',
    (await page.locator('.drawer select').first().inputValue()) === 'reasoning',
  );

  // A plain-looking model must flip the type back, visibly.
  await page.locator('.model-chips .chip', { hasText: 'gpt-4o-mini' }).click();
  await page.waitForTimeout(250);
  check(
    '普通模型名会说明已自动切换类型',
    ((await page.textContent('.drawer')) ?? '').includes('自动设为普通模型'),
  );
  check(
    '普通模型名后类型为普通模型',
    (await page.locator('.drawer select').first().inputValue()) === 'plain',
  );

  const savedConfig = await page.evaluate('localStorage.getItem("apk-evaluator.llm-config.v1")');
  check(
    '模型与类型已持久化',
    Boolean(savedConfig) &&
      JSON.parse(savedConfig as string).model === 'gpt-4o-mini' &&
      JSON.parse(savedConfig as string).reasoningModel === false &&
      JSON.parse(savedConfig as string).thinkingStartTag === '<think>',
    String(savedConfig).slice(0, 200),
  );

  await page.unroute('**/models');

  /* ------------------------------------------------------------- reset */

  // "还原" was previously untested, which is how it shipped broken: it restored
  // text by index only, so an added turn shifted the baseline and wrote one
  // reply's text into another row, and a row marked deleted could never be
  // un-deleted (the button even stayed disabled, so it looked inert).
  console.log('\n[9] 还原改动');
  await runResetChecks(browser, url, datasetPath, errors);

  /* ---------------------------------------------- save guard + clarity */

  console.log('\n[10] 保存目标保护与操作可读性');
  await runSaveAndClarityChecks(browser, url, datasetPath, errors);

  console.log('\n[11] 目录导入');
  await runDirectoryImportChecks(browser, url, errors);

  /* ------------------------------------------------------- no JS errors */

  console.log('\n[12] 运行时错误检查');
  // Ignore the aborted-download noise the export blob can trigger.
  const realErrors = errors.filter(
    (e) => !/Download the React DevTools|favicon/i.test(e),
  );
  check('无未捕获的运行时错误', realErrors.length === 0, realErrors.join(' | '));

  await browser.close();

  console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}: ${checks - failures}/${checks}`);
}

/**
 * Exercises the "还原改动" button in four independent, freshly loaded pages.
 *
 * Each case needs a clean store, and the store lives only in memory, so a new
 * context per case is both simpler and stricter than trying to unwind state.
 */
async function runResetChecks(
  browser: Browser,
  url: string,
  datasetPath: string,
  errors: string[],
): Promise<void> {
  const openFresh = async (): Promise<Page> => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await p.goto(url, { waitUntil: 'networkidle' });
    p.once('filechooser', (fc) => void fc.setFiles([datasetPath]));
    await p.click('.toolbar button:has-text("导入")');
    await p.click('.sheet-actions button:has-text("选择文件")');
    await p.waitForSelector('.sample-card');
    return p;
  };

  /** Reads rendered editor values, expanding the card first when needed. */
  const valuesOf = async (p: Page, cardIndex: number): Promise<string[]> => {
    const card = p.locator('.sample-card').nth(cardIndex);
    if ((await card.locator('.edit-surface').count()) === 0) {
      await card.locator('.sample-head').click();
      await card.locator('.edit-surface').first().waitFor({ timeout: 5000 });
    }
    return card
      .locator('.edit-surface')
      .evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));
  };

  const resetButton = (p: Page) => p.locator('.toolbar button:has-text("还原全部")');

  // --- a text edit is reverted -------------------------------------------
  {
    const p = await openFresh();
    await p.locator('.sample-card').first().locator('.sample-head').click();
    await p.waitForSelector('.sample-card.expanded .edit-surface');
    await typeInto(p, '.sample-card.expanded .edit-surface >> nth=1', '改过的回复一');
    await p.locator('.search-input').click();
    await p.waitForTimeout(400);

    check('改文本后还原按钮可用', !(await resetButton(p).isDisabled()));
    await resetButton(p).click();
    await p.waitForTimeout(500);

    const after = await valuesOf(p, 0);
    check(
      '还原恢复被修改的文本',
      JSON.stringify(after) === JSON.stringify(['介绍一下杭州', '杭州是浙江省的省会，以西湖闻名。']),
      JSON.stringify(after),
    );
    check('还原后按钮变为不可用', await resetButton(p).isDisabled());
    await p.context().close();
  }

  // --- a soft-deleted row is un-deleted ----------------------------------
  {
    const p = await openFresh();
    await p.locator('.sample-card').nth(1).locator('.sample-head').click();
    await p.waitForTimeout(300);
    await p.locator('.sample-card').nth(1).locator('button:has-text("标记删除")').click();
    await p.locator('.search-input').click();
    await p.waitForTimeout(400);

    check('标记删除后卡片为删除态', (await p.locator('.sample-card.deleted').count()) === 1);
    // Must be enabled even though no text changed, or the button looks inert.
    check('仅标记删除时还原按钮仍可用', !(await resetButton(p).isDisabled()));

    await resetButton(p).click();
    await p.waitForTimeout(500);
    check('还原清除删除标记', (await p.locator('.sample-card.deleted').count()) === 0);
    await p.context().close();
  }

  // --- an added turn is removed without corrupting the rest --------------
  {
    const p = await openFresh();
    await p.locator('.sample-card').first().locator('.sample-head').click();
    await p.waitForSelector('.sample-card.expanded .edit-surface');
    await p
      .locator('.sample-card.expanded .turn')
      .first()
      .locator('button:has-text("插入轮次")')
      .click();
    await p.locator('.search-input').click();
    await p.waitForTimeout(400);

    check(
      '插入后轮次数变为 3',
      (await p.locator('.sample-card').first().locator('.edit-surface').count()) === 3,
    );
    await resetButton(p).click();
    await p.waitForTimeout(500);

    const after = await valuesOf(p, 0);
    check('还原移除新增轮次', after.length === 2, JSON.stringify(after));
    // Guards the exact regression: an index-shifted baseline used to duplicate
    // the reply instead of reverting it.
    check(
      '还原后内容无重复',
      JSON.stringify(after) ===
        JSON.stringify(['介绍一下杭州', '杭州是浙江省的省会，以西湖闻名。']),
      JSON.stringify(after),
    );
    await p.context().close();
  }

  // --- a duplicated row is dropped ---------------------------------------
  {
    const p = await openFresh();
    await p.locator('.sample-card').first().locator('.sample-head').click();
    await p.waitForSelector('.sample-card.expanded .edit-surface');
    await p.locator('.sample-card').first().locator('button:has-text("复制此条")').click();
    await p.locator('.search-input').click();
    await p.waitForTimeout(400);

    check('复制后样本数为 4', (await p.locator('.sample-card').count()) === 4);
    await resetButton(p).click();
    await p.waitForTimeout(500);
    check('还原移除复制的样本', (await p.locator('.sample-card').count()) === 3);
    await p.context().close();
  }
}

/**
 * Covers the two things that were previously unclear or unsafe:
 *
 *  - the save sheet must refuse a file name that matches an imported dataset,
 *    because the native writer replaces a same-named file and would destroy the
 *    input the user is still cleaning
 *  - the per-turn actions and the batch panel must state, in words, what they
 *    do and how many turns a run will touch
 */
async function runSaveAndClarityChecks(
  browser: Browser,
  url: string,
  datasetPath: string,
  errors: string[],
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(url, { waitUntil: 'networkidle' });
  p.once('filechooser', (fc) => void fc.setFiles([datasetPath]));
  await p.click('.toolbar button:has-text("导入")');
  await p.click('.sheet-actions button:has-text("选择文件")');
  await p.waitForSelector('.sample-card');

  // --- batch panel states its scope before spending tokens ---------------
  const batchText = (await p.textContent('.batch-panel')) ?? '';
  check('批量面板标题说明用途', batchText.includes('用 AI 批量修改'));
  check('批量面板显示将影响的轮次数', /共\s*\d+\s*个/.test(batchText), batchText.slice(0, 120));
  check('批量面板内可见范围选择', (await p.locator('.batch-options select').count()) === 2);
  check(
    '开始按钮写明轮次数',
    /开始修改\s*\d+\s*个轮次/.test((await p.textContent('.batch-run')) ?? ''),
    (await p.textContent('.batch-run')) ?? '',
  );

  // --- per-turn actions are labelled, not symbols -----------------------
  await p.locator('.sample-card').first().locator('.sample-head').click();
  await p.waitForSelector('.sample-card.expanded .edit-surface');
  const turnText = (await p.textContent('.turn-head')) ?? '';
  check('轮次操作用文字而非符号', !/(^|\s)\+\s*$/.test(turnText) && !turnText.includes('×'));
  check('有「插入轮次」按钮', (await p.locator('button:has-text("插入轮次")').count()) > 0);
  check('有「删除轮次」按钮', (await p.locator('button:has-text("删除轮次")').count()) > 0);
  check('有「还原本轮」按钮', (await p.locator('button:has-text("还原本轮")').count()) > 0);
  check('有单轮「AI 改写」按钮', (await p.locator('button:has-text("AI 改写")').count()) > 0);

  // --- save sheet describes the destination and the payload -------------
  await p.click('.toolbar button:has-text("另存为")');
  await p.waitForSelector('.sheet .sheet-actions');
  const saveText = (await p.textContent('.sheet')) ?? '';
  check('保存面板显示保存位置', saveText.includes('保存位置'));
  check('保存面板说明不改原文件', saveText.includes('原始文件不会被修改'));
  check('保存面板写明将写入条数', /将写入\s*3\s*条/.test(saveText), saveText.slice(0, 160));

  // --- a name matching a source file is refused -------------------------
  const nameInput = p.locator('.sheet input[type="text"]');
  await nameInput.fill('sample.jsonl');
  await p.waitForTimeout(300);
  check('与原始文件同名时出现警告', (await p.locator('.warn-box').count()) === 1);
  check(
    '警告说明不能覆盖原文件',
    ((await p.textContent('.warn-box')) ?? '').includes('不能覆盖'),
  );
  check(
    '同名时保存按钮被禁用',
    await p.locator('.sheet-actions button.primary').isDisabled(),
  );

  // The suggested replacement must clear the conflict.
  await p.click('.warn-box button');
  await p.waitForTimeout(300);
  const replaced = await nameInput.inputValue();
  check('一键改用不冲突的文件名', replaced === 'sample.cleaned.jsonl', replaced);
  check('改名后警告消失', (await p.locator('.warn-box').count()) === 0);
  check(
    '改名后保存按钮可用',
    !(await p.locator('.sheet-actions button.primary').isDisabled()),
  );

  await ctx.close();
}

/**
 * Covers directory import on both kinds of browser.
 *
 * The failure this guards against: most mobile browsers cannot select a folder
 * at all, and the old code returned an empty list, so "选择目录" looked like it
 * silently did nothing. It must instead be refused up front with an explanation.
 */
async function runDirectoryImportChecks(
  browser: Browser,
  url: string,
  errors: string[],
): Promise<void> {
  const openSheet = async (p: Page) => {
    await p.click('.toolbar button:has-text("导入")');
    await p.waitForSelector('.sheet-actions', { timeout: 5000 });
  };

  // --- Case A: no folder picker of any kind -----------------------------
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    // Simulate a browser whose file picker has no "select folder" affordance.
    await ctx.addInitScript(`
      try { delete HTMLInputElement.prototype.webkitdirectory; } catch (e) {}
      try {
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined, configurable: true, writable: true,
        });
      } catch (e) {}
    `);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url, { waitUntil: 'networkidle' });

    const stillSupported = await p.evaluate(
      "'webkitdirectory' in HTMLInputElement.prototype || typeof window.showDirectoryPicker === 'function'",
    );
    check('已模拟出不支持目录选择的环境', !stillSupported, String(stillSupported));

    await openSheet(p);
    const dirButton = p.locator('.sheet-actions button:has-text("选择目录")');
    check('不支持时目录按钮被禁用', await dirButton.isDisabled());
    check(
      '不支持时给出可执行的替代方案',
      ((await p.textContent('.warn-box')) ?? '').includes('选择文件（可多选）'),
    );
    check(
      '不支持时提示 APK 可用',
      ((await p.textContent('.warn-box')) ?? '').includes('APK'),
    );
    await ctx.close();
  }

  // --- Case B: File System Access API available -------------------------
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    // A fake two-level tree, exercising the recursive walk.
    await ctx.addInitScript(`
      const rec = (q, a) => JSON.stringify({
        conversations: [{ from: 'human', value: q }, { from: 'gpt', value: a }],
        _input_fingerprint: 'fp-' + q,
      });
      const file = (name, text) => ({
        kind: 'file', name, getFile: async () => new File([text], name),
      });
      window.showDirectoryPicker = async () => ({
        kind: 'directory',
        name: 'root',
        entries: async function* () {
          yield ['a.jsonl', file('a.jsonl', rec('问A', '答A') + '\\n' + rec('问A2', '答A2'))];
          yield ['notes.txt', file('notes.txt', 'ignore me')];
          yield ['sub', {
            kind: 'directory',
            name: 'sub',
            entries: async function* () {
              yield ['b.jsonl', file('b.jsonl', rec('问B', '答B'))];
            },
          }];
        },
      });
    `);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url, { waitUntil: 'networkidle' });

    await openSheet(p);
    const dirButton = p.locator('.sheet-actions button:has-text("选择目录")');
    check('支持时目录按钮可用', !(await dirButton.isDisabled()));
    check('支持时不显示警告', (await p.locator('.warn-box').count()) === 0);

    await dirButton.click();
    await p.waitForSelector('.sample-card', { timeout: 10_000 });
    // 2 from a.jsonl + 1 from sub/b.jsonl; notes.txt must be ignored.
    check(
      '递归导入子目录并忽略非数据集文件',
      (await p.locator('.sample-card').count()) === 3,
      String(await p.locator('.sample-card').count()),
    );
    await ctx.close();
  }
}

main()
  .catch((err) => {
    console.error('\n测试脚本自身出错:', err);
    failures++;
  })
  .finally(async () => {
    await server?.close();
    process.exit(failures === 0 ? 0 : 1);
  });
