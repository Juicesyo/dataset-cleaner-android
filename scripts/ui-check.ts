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

import { chromium, type Page } from 'playwright';
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
  // point on the "还原" button at this viewport width and reset everything.
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

  await page.click('.toolbar button:has-text("导出")');
  await page.waitForSelector('.sheet .sheet-actions', { timeout: 5000 });
  await page.click('button:has-text("保存清理后的 JSONL")');
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

  /* ------------------------------------------------------- no JS errors */

  console.log('\n[9] 运行时错误检查');
  // Ignore the aborted-download noise the export blob can trigger.
  const realErrors = errors.filter(
    (e) => !/Download the React DevTools|favicon/i.test(e),
  );
  check('无未捕获的运行时错误', realErrors.length === 0, realErrors.join(' | '));

  await browser.close();

  console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}: ${checks - failures}/${checks}`);
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
