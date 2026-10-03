// Capture the dashboard to screenshots/stage1.png (dev servers must be running).
import { chromium } from 'playwright';
const url = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:5173';
const out = process.argv[2] ?? 'screenshots/stage1.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="height"]')?.textContent ?? ''));
await page.waitForTimeout(1500); // let entrance animations settle
const h = await page.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width: 1440, height: h });
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}`);
