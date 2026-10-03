// Stage 8 screenshots against the simulated myNode (scripts/mynode-sim.sh up + verify-mynode-sim.mts, which sets the passphrase).
import { chromium } from 'playwright';
import { copyFileSync, mkdirSync } from 'node:fs';

const URL0 = process.env.APP_URL ?? 'http://127.0.0.1:19330';
const PASS = process.env.APP_PASSPHRASE ?? 'correct horse battery staple mynode';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(URL0);
await page.getByTestId('login').waitFor();
await page.getByLabel('App passphrase').fill(PASS);
await page.screenshot({ path: 'screenshots/stage8-login.png' });
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByTestId('split-banner').waitFor();
await page.getByTestId('wallet-chain').waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: 'screenshots/stage8-dashboard-mynode.png', fullPage: true });
await browser.close();
mkdirSync('mynode/btctrust/screenshots', { recursive: true });
copyFileSync('screenshots/stage8-login.png', 'mynode/btctrust/screenshots/login.png');
copyFileSync('screenshots/stage8-dashboard-mynode.png', 'mynode/btctrust/screenshots/dashboard.png');
console.log('saved screenshots/stage8-login.png, screenshots/stage8-dashboard-mynode.png');
