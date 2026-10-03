// Captures screenshots/stage3-devices.png and stage3-sign.png. Needs dev servers, Trezor emulator (scripts/trezor-emu.sh start)
// and a wallet with a hardware cosigner (default: first multisig with a hardware key).
import { chromium } from 'playwright';
const UI = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:5173';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const wallets = await (await fetch(`${API}/api/wallets`)).json();
const vault = wallets.find((w) => w.type === 'multisig' && w.cosigners.some((c) => c.kind === 'hardware'));
if (!vault) throw new Error('No wallet with a hardware cosigner; create one first');
const spend = wallets.find((w) => w.type === 'singlesig' && w.cosigners[0].kind === 'software');
const dest = (await (await fetch(`${API}/api/wallets/${spend.id}/address`, { method: 'POST' })).json()).address;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const shot = async (path) => {
  await page.addStyleTag({ content: '.modal-backdrop{place-items:start center!important;overflow:auto} .modal{max-height:none!important}' });
  await page.waitForTimeout(1200);
  const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, (document.querySelector('.modal')?.getBoundingClientRect().bottom ?? 0) + 60));
  await page.setViewportSize({ width: 1440, height: Math.max(1000, h) });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const m = document.querySelector('.modal'); if (m) m.scrollTop = 0; });
  await page.waitForTimeout(200);
  await page.screenshot({ path });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('saved', path);
};

await page.goto(`${UI}/#/devices`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="device-card"]');
await page.click('text=Show xpub');
await page.waitForSelector('.xpub-box');
await shot('screenshots/stage3-devices.png');

await page.goto(`${UI}/#/wallets?new=multisig&hw=5c9e228d`, { waitUntil: 'networkidle' });
await page.waitForSelector('[aria-label="Device 1"]');
await page.click('[data-testid="slot-2-airgapped"]');
await shot('screenshots/stage3-wizard.png');

await page.goto(`${UI}/#/wallets/${vault.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="receive-address"]');
await page.click('[data-testid="verify-device"]');
await page.waitForSelector('.verify.v-ok', { timeout: 60000 });
await shot('screenshots/stage3-wallet-detail.png');

await page.click('text=↗ Send');
await page.fill('input[placeholder="bcrt1…"]', dest);
await page.fill('input[placeholder="0.00"]', '1.5');
await page.click('text=Create PSBT');
await page.waitForSelector('text=⌁ Sign on device');
await page.click('text=⌁ Sign on device');
await page.waitForFunction(() => document.querySelector('[data-testid="sig-progress"]')?.textContent?.includes('1/2'), null, { timeout: 120000 });
await page.click('text=✈ Air-gapped signing · PSBT file / QR');
await page.click('text=▦ Show QR');
await shot('screenshots/stage3-sign.png');
await browser.close();
