// v0.8.4 screenshots + UI walk-through: fiat value under BTC amounts, the currency picker, JPY (no decimals), sats.
// Runs against a running app (default: the myNode simulation on :19330) with an existing wallet.
//   APP_URL=http://127.0.0.1:19330 PASS='…' WALLET_ID=… tsx scripts/screenshot-v084.mts
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:19330';
const id = process.env.WALLET_ID!;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, baseURL: APP });
const ok = (await ctx.request.post('/api/auth/login', { data: { passphrase: process.env.PASS } })).ok();
if (!ok) throw new Error('login failed');
await ctx.request.put('/api/settings/display', { data: { unit: 'BTC', fiat: 'USD' } });
await ctx.request.post('/api/regtest/fund', { data: { walletId: id, amount: 2 } });
const page = await ctx.newPage();
const shot = async (path: string, el?: string) => {
  await page.waitForTimeout(800);
  if (el) await page.locator(el).first().screenshot({ path }); else await page.screenshot({ path, fullPage: true });
  console.log('saved', path);
};
await page.goto(`/#/wallets/${id}`);
const fiat = page.locator('.balance-card [data-testid="fiat-value"]');
await fiat.waitFor();
console.log('USD:', await fiat.textContent());
await shot('screenshots/v084-wallet-usd.png', '.balance-card');
await page.locator('.balance-card button.amt-main').click();
await page.getByRole('dialog', { name: 'Display currency' }).waitFor();
await shot('screenshots/v084-currency-picker.png', '.modal');
await page.getByTestId('cur-JPY').click();
await page.waitForFunction(() => document.querySelector('.balance-card [data-testid="fiat-value"]')?.textContent?.includes('¥'));
console.log('JPY:', await fiat.textContent());
await shot('screenshots/v084-wallet-jpy.png', '.balance-card');
await page.locator('.balance-card button.amt-main').click();
await page.getByRole('radio', { name: /sats/ }).click();
await page.getByTestId('cur-EUR').click();
await page.goto('/#/wallets');
await page.getByTestId('wallets-total').waitFor();
await page.waitForFunction(() => document.querySelector('[data-testid="fiat-value"]')?.textContent?.includes('€'));
console.log('total:', await page.getByTestId('wallets-total').textContent(), await page.locator('[data-testid="fiat-value"]').first().textContent());
await shot('screenshots/v084-wallets-sats-eur.png');
const saved = await (await ctx.request.get('/api/settings/display')).json();
console.log('saved on the node:', JSON.stringify(saved));
await ctx.request.put('/api/settings/display', { data: { unit: 'BTC', fiat: 'USD' } });
await browser.close();
if (saved.unit !== 'sats' || saved.fiat !== 'EUR') process.exit(1);
