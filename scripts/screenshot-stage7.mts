// Stage 7 screenshots: encrypted keyring unlock, animated BC-UR PSBT QR (one frame), Coldcard setup file.
// Needs the dev servers (scripts/dev.sh) and regtest bitcoind. Uses data/demo-trustee-keys.json (gitignored demo keys).
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

const UI = process.env.UI_URL ?? 'http://127.0.0.1:5173';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const KEYS = 'data/demo-trustee-keys.json';
const PASS = 'demo keyring passphrase';
const get = async (p: string) => (await fetch(`${API}${p}`)).json() as Promise<any>;

const wallets: any[] = await get('/api/wallets');
const family = wallets.find((w) => w.id.startsWith('family-trust-vault')) ?? wallets.find((w) => w.type === 'multisig');
const big = wallets.filter((w) => w.type === 'multisig' && w.balance.total > 1).sort((a, b) => b.n - a.n)[0];
const trezor = wallets.find((w) => w.id.startsWith('trezor-trust-vault')) ?? big;
const dest = (await (await fetch(`${API}/api/wallets/${wallets.find((w) => w.type === 'singlesig').id}/address`, { method: 'POST' })).json()).address;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const shot = async (path: string, full = true) => {
  await page.waitForTimeout(900);
  if (full) { const h = await page.evaluate(() => document.documentElement.scrollHeight); await page.setViewportSize({ width: 1440, height: Math.max(1000, h) }); await page.waitForTimeout(500); }
  await page.screenshot({ path });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('saved', path);
};

// 1. Encrypted keyring: seed the demo keys as a legacy plaintext v1 ring, migrate them through the UI, reload → locked prompt.
const demo = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8'))[family.id] ?? {} : {};
const ring = { [family.id]: Object.fromEntries(Object.values(demo).map((id: any) => [id.fingerprint, { current: id, previous: [] }])) };
await page.goto(`${UI}/#/`, { waitUntil: 'networkidle' });
await page.evaluate(([k, a]) => { localStorage.clear(); localStorage.setItem('btctrust-trustee-keys-v1', k); localStorage.setItem('btctrust-acting-v1', a); },
  [JSON.stringify(ring), JSON.stringify({ [family.id]: Object.keys(demo)[0] })]);
await page.goto(`${UI}/#/messages/${family.id}`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' }); // hash navigation keeps the old in-memory keystore
await page.waitForSelector('[data-testid="keygate-legacy"]');
await page.fill('#kg-pass', PASS); await page.fill('#kg-confirm', PASS);
await page.click('text=Encrypt & migrate');
await page.waitForSelector('[data-testid="keybar"]');
const stored = await page.evaluate(() => ({ v1: localStorage.getItem('btctrust-trustee-keys-v1'), v2: JSON.parse(localStorage.getItem('btctrust-trustee-keys-v2') ?? '{}') }));
if (stored.v1 !== null || stored.v2.v !== 2 || JSON.stringify(stored.v2).includes('signSecret')) throw new Error('migration did not encrypt the keyring');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="keygate-locked"]');
await page.fill('#kg-pass', 'wrong passphrase!'); await page.click('button:has-text("Unlock")');
await page.waitForTimeout(2500); // scrypt N=2^17 in the browser
await shot('screenshots/stage7-keys-unlock.png', false);
await page.fill('#kg-pass', PASS); await page.click('button:has-text("Unlock")');
await page.waitForSelector('[data-testid="keybar"]', { timeout: 20000 });
await page.waitForSelector('.vb-local', { timeout: 20000 }).catch(() => {});
console.log('unlocked; browser-verified badges:', await page.locator('.vb-local').count(), 'rejected:', await page.locator('[data-testid^="rejected-"]').count());

// 2. Animated BC-UR QR for a large multisig PSBT.
await page.goto(`${UI}/#/wallets/${big.id}`, { waitUntil: 'networkidle' });
await page.click('text=↗ Send');
await page.fill('input[placeholder="bcrt1…"]', dest);
await page.fill('input[placeholder="0.00"]', '0.25');
await page.click('text=Create PSBT');
await page.waitForSelector('.psbt-box');
await page.evaluate(() => { const d = document.querySelector('details.psbt-box') as HTMLDetailsElement; d.open = true; });
await page.click('text=▦ Show QR');
await page.waitForSelector('[data-testid="animated-qr"]');
await page.waitForTimeout(1500);
console.log('UR part:', (await page.getAttribute('[data-testid="animated-qr"]', 'data-part'))?.slice(0, 40));
// The send flow is a scrolling modal: let it grow to full height and capture just the dialog.
const modalH = await page.evaluate(() => {
  const m = document.querySelector('.send')!.closest('[class*="modal"]:not([class*="backdrop"])') as HTMLElement;
  for (let e: HTMLElement | null = document.querySelector('.send'); e && e !== document.body; e = e.parentElement) { e.style.maxHeight = 'none'; e.style.overflow = 'visible'; }
  m.setAttribute('data-shot', 'modal');
  return m.getBoundingClientRect().height;
});
await page.setViewportSize({ width: 1440, height: Math.ceil(modalH) + 120 });
await page.waitForTimeout(1200);
await page.locator('[data-shot="modal"]').screenshot({ path: 'screenshots/stage7-animated-qr.png' });
await page.setViewportSize({ width: 1440, height: 1000 });
console.log('saved screenshots/stage7-animated-qr.png');

// 3. Coldcard setup file on the Trezor trust vault's Device registration tab.
await page.goto(`${UI}/#/wallets/${trezor.id}`, { waitUntil: 'networkidle' });
await page.click('role=tab[name="Device registration"]');
await page.waitForSelector('[data-testid="coldcard-file"]');
await page.locator('[data-testid="device-registration"]').scrollIntoViewIfNeeded();
await shot('screenshots/stage7-coldcard.png');
await browser.close();
