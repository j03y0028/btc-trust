// v0.8.3 screenshots + UI walk-through: inline rename (pencil) and the danger-zone delete of a throwaway test wallet.
// Needs the dev servers (scripts/dev.sh) and regtest bitcoind. Creates and deletes its own wallet "Whitfeild Test Trust".
import { chromium } from 'playwright';

const UI = process.env.UI_URL ?? 'http://127.0.0.1:5173';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const post = async (p: string, b: unknown) => (await fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as Promise<any>;

const w = await post('/api/wallets', { name: 'Whitfeild Test Trust', type: 'multisig', m: 2, n: 3, cosignerLabels: ['Jordan', 'Avery Whitfield', 'Mateo Whitfield'] });
await post('/api/regtest/fund', { walletId: w.id, amount: 2 });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
const shot = async (path: string, el?: string) => {
  await page.waitForTimeout(700);
  if (el) await page.locator(el).first().screenshot({ path }); else await page.screenshot({ path, fullPage: true });
  console.log('saved', path);
};
await page.goto(`${UI}/#/wallets/${w.id}`);
await page.getByText('Whitfeild Test Trust').first().waitFor();
await page.getByRole('button', { name: 'Rename wallet' }).click();
await page.getByLabel('Wallet name').fill('Whitfield Test Trust');
await shot('screenshots/v083-rename.png', '.balance-card');
await page.getByRole('button', { name: 'Save' }).click();
await page.getByRole('heading', { name: 'Whitfield Test Trust' }).waitFor();
await shot('screenshots/v083-wallet-danger-zone.png');
await page.getByTestId('delete-wallet').click();
await page.getByLabel('Type the wallet name to confirm').fill('Whitfield Test Trust');
await shot('screenshots/v083-delete-confirm.png', '.modal');
await page.getByTestId('confirm-delete').click();
await page.waitForURL(/#\/wallets$/);
const still = await (await fetch(`${API}/api/wallets/${w.id}`)).status;
console.log('after delete GET status', still, 'url', page.url());
await browser.close();
if (still !== 404) process.exit(1);
