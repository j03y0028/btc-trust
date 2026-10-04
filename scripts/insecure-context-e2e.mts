// Real-browser test of the trustee keyring over plain HTTP on a non-localhost address (an "insecure context",
// where browsers hide crypto.subtle), e.g. http://192.168.1.119 on a real myNode.
//   APP_URL=http://172.30.0.2:19331 PASS='…' WALLET_ID=… BROWSERS=webkit,firefox,chromium EXPECT=pass|fail tsx scripts/insecure-context-e2e.mts
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const APP = process.env.APP_URL!;
const ID = process.env.WALLET_ID!;
const EXPECT = process.env.EXPECT ?? 'pass';
const KEYPASS = 'whitfield trustee keyring 2026';
const engines: Record<string, BrowserType> = { webkit, firefox, chromium };
let bad = 0;
for (const name of (process.env.BROWSERS ?? 'webkit,firefox,chromium').split(',')) {
  const browser = await engines[name].launch();
  const ctx = await browser.newContext({ baseURL: APP });
  if (!(await ctx.request.post('/api/auth/login', { data: { passphrase: process.env.PASS } })).ok()) throw new Error('login failed');
  const page = await ctx.newPage();
  await page.goto(`/#/messages/${ID}`);
  await page.locator('[data-testid="keygate-empty"]').waitFor({ timeout: 30_000 });
  const env = await page.evaluate(() => ({ secure: window.isSecureContext, subtle: typeof globalThis.crypto?.subtle, rv: (() => { try { return crypto.getRandomValues(new Uint8Array(4)).length === 4 } catch { return false } })() }));
  await page.fill('#kg-pass', KEYPASS);
  await page.fill('#kg-confirm', KEYPASS);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Create encrypted keyring' }).click();
  const outcome = await Promise.race([
    page.locator('[data-testid="keybar"]').waitFor({ timeout: 120_000 }).then(() => 'created'),
    page.locator('.keygate [role="alert"]').waitFor({ timeout: 120_000 }).then(async () => `error: ${await page.locator('.keygate [role="alert"]').textContent()}`),
  ]);
  const createMs = Date.now() - t0;
  let unlock = '-';
  if (outcome === 'created') {
    // reload = locked; unlock with the passphrase (decrypt path), and a wrong passphrase must be refused
    await page.reload();
    await page.locator('[data-testid="keygate-locked"]').waitFor();
    await page.fill('#kg-pass', 'not the right passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();
    const wrong = await page.locator('.keygate [role="alert"]').textContent({ timeout: 120_000 });
    await page.fill('#kg-pass', KEYPASS);
    const t1 = Date.now();
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.locator('[data-testid="keybar"]').waitFor({ timeout: 120_000 });
    unlock = `ok in ${Date.now() - t1} ms (wrong passphrase: "${wrong}")`;
  }
  const passed = outcome === 'created' && unlock.startsWith('ok');
  if ((EXPECT === 'pass') !== passed) bad++;
  console.log(`${name.padEnd(8)} isSecureContext=${env.secure} crypto.subtle=${env.subtle} getRandomValues=${env.rv} | create: ${outcome} (${createMs} ms) | unlock: ${unlock}`);
  await browser.close();
}
console.log(bad ? `UNEXPECTED (${bad})` : `as expected (${EXPECT})`);
process.exit(bad ? 1 : 0);
