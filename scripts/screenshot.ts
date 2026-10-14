/** Captures screenshots of the app for visual review. */
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector);
  await el.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text, { delay: 4 });
}

const tmp = mkdtempSync(join(tmpdir(), 'shot-'));
const p = join(tmp, 'sample.jsonl');
const recs = [
  {
    conversations: [
      { from: 'human', value: '帮我介绍一下杭州这座城市的主要特点。' },
      {
        from: 'gpt',
        value:
          '杭州是浙江省的省会，地处长江三角洲南翼。\n\n它最著名的地标是西湖，此外还有灵隐寺、京杭大运河等历史遗迹。\n\n近年来杭州的数字经济发展迅速，聚集了大量互联网企业。',
      },
    ],
    _input_fingerprint: 'fp-9f2c1a7b3e',
  },
  {
    conversations: [
      { from: 'human', value: '今天杭州天气怎么样？' },
      { from: 'gpt', value: '抱歉，我无法获取实时的天气数据，建议你查看天气预报应用。' },
    ],
    _input_fingerprint: 'fp-second-record',
  },
  {
    conversations: [
      { from: 'human', value: '推荐几道杭帮菜。' },
      {
        from: 'gpt',
        value: '西湖醋鱼、东坡肉、龙井虾仁、宋嫂鱼羹都是经典的杭帮菜。',
      },
    ],
    _input_fingerprint: 'fp-third-record',
  },
];
writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const server = await createServer({ root: process.cwd(), server: { port: 5184, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
await page.goto('http://localhost:5184/', { waitUntil: 'networkidle' });

await page.screenshot({ path: 'screenshot-empty.png' });

page.once('filechooser', (fc) => fc.setFiles([p]));
await page.click('.toolbar button:has-text("导入")');
await page.click('.sheet-actions button:has-text("选择文件")');
await page.waitForSelector('.sample-card');
await page.waitForTimeout(300);

// Expand the first record and make an edit that produces a visible diff.
await page.locator('.sample-card').first().locator('.sample-head').click();
await page.waitForSelector('.sample-card.expanded .edit-surface');
await typeInto(
  page,
  '.sample-card.expanded .edit-surface >> nth=1',
  '杭州是浙江省的省会，位于长江三角洲南翼。\n\n最著名的地标是西湖，此外还有灵隐寺、京杭大运河等历史遗迹，2023 年亚运会也在此举办。\n\n近年来杭州的数字经济（电子商务、云计算）发展迅速，聚集了大量互联网企业。',
);
await page.waitForTimeout(500);
await page.locator('.search-input').click(); // blur to settle the layout
await page.waitForTimeout(400);

await page.screenshot({ path: 'screenshot-diff.png', fullPage: false });

// Scroll a little to capture a second card plus the toolbar.
await page.evaluate('window.scrollTo(0, 260)');
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshot-scrolled.png' });

// Settings drawer.
await page.click('.toolbar button:has-text("设置")');
await page.waitForSelector('.drawer');
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshot-settings.png' });

await browser.close();
await server.close();
console.log('screenshots written');
