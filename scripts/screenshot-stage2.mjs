// Captures screenshots/stage2-wallets.png and stage2-send.png (dev servers + seeded demo wallets required).
import { chromium } from 'playwright';
const UI = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:5173';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const wallets = await (await fetch(`${API}/api/wallets`)).json();
const vault = wallets.find((w) => w.type === 'multisig' && w.n === 3) ?? wallets[0];
const dest = (await (await fetch(`${API}/api/wallets/${wallets.find((w) => w.type === 'singlesig').id}/address`, { method: 'POST' })).json()).address;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const shot = async (path) => {
  await page.waitForTimeout(1200);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1440, height: Math.max(1000, h) });
  await page.waitForTimeout(400);
  await page.screenshot({ path });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('saved', path);
};

await page.goto(`${UI}/#/wallets`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="wallet-card"]');
await shot('screenshots/stage2-wallets.png');

// Wizard (bonus): type picker with multisig default
await page.click('text=＋ New wallet');
await page.waitForSelector('[data-testid="type-multisig"]');
await shot('screenshots/stage2-wizard.png');
await page.keyboard.press('Escape');

await page.goto(`${UI}/#/wallets/${vault.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="receive-address"]');
await shot('screenshots/stage2-wallet-detail.png');

await page.click('text=↗ Send');
await page.fill('input[placeholder="bcrt1…"]', dest);
await page.fill('input[placeholder="0.00"]', '2.5');
await page.click('text=Create PSBT');
await page.waitForSelector('[data-testid="sig-progress"]');
await page.getByRole('button', { name: 'Sign' }).first().click();
await page.waitForFunction(() => document.querySelector('[data-testid="sig-progress"]')?.textContent?.includes('1/2'));
await shot('screenshots/stage2-send.png');
await browser.close();
