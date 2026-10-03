// Captures screenshots/stage6-timeline.png and stage6-goals.png (needs dev servers: bash scripts/dev.sh).
// Uses only real cached data: FRED CSVs, data/daily-blocks.json, data/mainnet-reference.json, git history.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const UI = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:5173';
mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

await page.goto(`${UI}/#/timeline`);
await page.waitForSelector('.tl-chart .recharts-surface', { timeout: 60_000 });
await page.waitForSelector('.genesis-card .times');
await page.waitForTimeout(1200);
// hover a crisis-era month so the tooltip shows values + the event
const box = await page.locator('.tl-chart .recharts-surface').first().boundingBox();
if (box) await page.mouse.move(box.x + box.width * 0.33, box.y + box.height * 0.45);
await page.waitForTimeout(500);
await page.screenshot({ path: 'screenshots/stage6-timeline.png', fullPage: true });

await page.goto(`${UI}/#/goals`);
await page.waitForSelector('[data-testid="goal-stage-6"]');
await page.waitForTimeout(1400);
await page.screenshot({ path: 'screenshots/stage6-goals.png', fullPage: true });
await browser.close();
console.log('saved screenshots/stage6-timeline.png, screenshots/stage6-goals.png');
