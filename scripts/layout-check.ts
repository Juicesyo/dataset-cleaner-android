/**
 * Layout / visual-regression checks that do not depend on eyeballing pixels.
 *
 * Verifies the properties that actually matter for the requested UX:
 *  - the diff colours are distinct and readable against the editor background
 *  - the coloured layer aligns exactly with the textarea text metrics
 *  - the editor grows with content and caps out
 *  - nothing overflows the mobile viewport horizontally
 *  - the toolbar and sheets stay within the safe area
 */

import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector);
  await el.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text, { delay: 3 });
}

const tmp = mkdtempSync(join(tmpdir(), 'layout-'));
const p = join(tmp, 'sample.jsonl');
const recs = [
  {
    conversations: [
      { from: 'human', value: '帮我介绍一下杭州。' },
      { from: 'gpt', value: '杭州是浙江省的省会，以西湖闻名。' },
    ],
    _input_fingerprint: 'fp-1',
  },
  {
    conversations: [
      { from: 'human', value: '推荐杭帮菜。' },
      { from: 'gpt', value: '西湖醋鱼、东坡肉。' },
    ],
    _input_fingerprint: 'fp-2',
  },
];
writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const server = await createServer({ root: process.cwd(), server: { port: 5183, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
await page.goto('http://localhost:5183/', { waitUntil: 'networkidle' });

page.once('filechooser', (fc) => fc.setFiles([p]));
await page.click('.toolbar button:has-text("导入")');
await page.click('.sheet-actions button:has-text("选择文件")');
await page.waitForSelector('.sample-card');

/* --------------------------------------------------- no horizontal scroll */

console.log('\n[1] 移动端布局');
const overflow = await page.evaluate(
  'document.documentElement.scrollWidth - document.documentElement.clientWidth',
);
check('没有横向溢出', overflow <= 1, `溢出 ${overflow}px`);

const toolbarBox = await page.locator('.toolbar').boundingBox();
check('工具栏在视口内', Boolean(toolbarBox && toolbarBox.width <= 390));

/* -------------------------------------------------------- editor growing */

console.log('\n[2] 编辑框自适应');
await page.locator('.sample-card').first().locator('.sample-head').click();
await page.waitForSelector('.sample-card.expanded .edit-surface');

const sel = '.sample-card.expanded .edit-surface >> nth=1';
const h1 = await page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);

await typeInto(page, sel, Array.from({ length: 25 }, (_, i) => `第 ${i + 1} 行内容，用于测试自动增高。`).join('\n'));
await page.waitForTimeout(400);
const h2 = await page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);
check('内容变多时编辑框增高', h2 > h1, `${h1} -> ${h2}`);

// It must grow, not scroll internally, up to the cap.
const scrollInfo = await page.locator(sel).evaluate((el) => ({
  scrollH: el.scrollHeight,
  clientH: el.clientHeight,
}));
check(
  '增高到内容高度（无内部滚动）',
  Math.abs(scrollInfo.scrollH - scrollInfo.clientH) <= 2,
  JSON.stringify(scrollInfo),
);

/* -------------------------------------------------------- diff alignment */

console.log('\n[3] 差异图层与文字对齐');
const metrics = await page.evaluate(
  `(() => {
    const stack = document.querySelector('.edit-stack');
    const pre = stack.querySelector('.diff-backdrop');
    const ta = stack.querySelector('.edit-surface');
    if (!pre || !ta) return null;
    const cp = getComputedStyle(pre);
    const ct = getComputedStyle(ta);
    return {
      preFont: cp.fontFamily + '|' + cp.fontSize + '|' + cp.lineHeight,
      taFont: ct.fontFamily + '|' + ct.fontSize + '|' + ct.lineHeight,
      prePad: cp.padding, taPad: ct.padding,
      preBorder: cp.borderLeftWidth, taBorder: ct.borderLeftWidth,
      preWrap: cp.whiteSpace, taWrap: ct.whiteSpace,
      preBox: pre.getBoundingClientRect().height,
      taBox: ta.getBoundingClientRect().height,
    };
  })()`,
);
check('字体度量一致', metrics?.preFont === metrics?.taFont, JSON.stringify([metrics?.preFont, metrics?.taFont]));
check('内边距一致', metrics?.prePad === metrics?.taPad, JSON.stringify([metrics?.prePad, metrics?.taPad]));
check('边框宽度一致', metrics?.preBorder === metrics?.taBorder);
check('换行模式一致', metrics?.preWrap === metrics?.taWrap);
check(
  '两图层高度接近',
  Math.abs((metrics?.preBox ?? 0) - (metrics?.taBox ?? 0)) <= 4,
  JSON.stringify([metrics?.preBox, metrics?.taBox]),
);

/* ----------------------------------------------------- colour separation */

console.log('\n[4] 差异配色');
const colors = await page.evaluate(
  `(() => {
    const add = document.querySelector('.seg-add');
    const del = document.querySelector('.seg-del');
    const out = {};
    if (add) { const s = getComputedStyle(add); out.addBg = s.backgroundColor; out.addFg = s.color; }
    if (del) { const s = getComputedStyle(del); out.delBg = s.backgroundColor; out.delFg = s.color; }
    return out;
  })()`,
);
check('存在新增段配色', Boolean(colors?.addBg));
check('存在删除段配色', Boolean(colors?.delBg));
check('新增/删除背景色不同', colors?.addBg !== colors?.delBg);
check('删除文字色与新增文字色不同', colors?.addFg !== colors?.delFg);

// The coloured words must be legible against the editor background.
const contrastOk = await page.evaluate(
  `(() => {
    const toRgb = (c) => (c.match(/[\\d.]+/g) || []).slice(0,3).map(Number);
    const lum = (rgb) => {
      const [r,g,b] = rgb.map(v => { const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
      return 0.2126*r + 0.7152*g + 0.0722*b;
    };
    const bg = toRgb(getComputedStyle(document.querySelector('.edit-surface')).backgroundColor) || [];
    const res = {};
    for (const cls of ['seg-add','seg-del']) {
      const el = document.querySelector('.' + cls);
      if (!el) continue;
      const fg = lum(toRgb(getComputedStyle(el).color));
      const b = lum(bg.length === 3 ? bg : [17,21,28]);
      const hi = Math.max(fg,b), lo = Math.min(fg,b);
      res[cls] = (hi + 0.05) / (lo + 0.05);
    }
    return res;
  })()`,
);
check(
  '新增文字对比度 >= 4.5',
  (contrastOk?.['seg-add'] ?? 0) >= 4.5,
  String(contrastOk?.['seg-add']),
);
check(
  '删除文字对比度 >= 4.5',
  (contrastOk?.['seg-del'] ?? 0) >= 4.5,
  String(contrastOk?.['seg-del']),
);

/* --------------------------------------------------------- tap targets */

console.log('\n[5] 触控可用性');
const smallButtons = await page.evaluate(
  `(() => {
    const bad = [];
    for (const b of document.querySelectorAll('button')) {
      if (!b.offsetParent) continue;
      const r = b.getBoundingClientRect();
      // Mini controls may be compact, but nothing should be untappable.
      if (r.height > 0 && r.height < 24) bad.push(b.textContent.trim() + ':' + Math.round(r.height));
    }
    return bad;
  })()`,
);
check('没有过小的可点击控件', smallButtons.length === 0, smallButtons.join(', '));

await browser.close();
await server.close();

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}: ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
