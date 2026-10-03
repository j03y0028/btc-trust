// Captures screenshots/stage4-vault-locked.png and stage4-vault.png.
// Needs dev servers (npm run dev) and the Trezor emulator (npm run emu:start). Seeds a demo vault on the first
// multisig wallet with a hardware cosigner if it has none yet. Regtest demo data only; the passphrase is a demo value.
import { chromium } from 'playwright';
const UI = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:5173';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const PASS = process.env.DEMO_VAULT_PASSPHRASE ?? 'regtest demo vault passphrase';

const wallets = await (await fetch(`${API}/api/wallets`)).json();
const w = wallets.find((x) => x.type === 'multisig' && x.cosigners.some((c) => c.kind === 'hardware')) ?? wallets.find((x) => x.type === 'multisig');
if (!w) throw new Error('No multisig wallet; run npm run seed first');
const hw = w.cosigners.findIndex((c) => c.kind === 'hardware');

let token = null;
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(`${API}/api/vaults/${w.id}${path}`, {
    method, headers: { ...(token ? { 'x-vault-session': token } : {}), ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const browser = await chromium.launch();
const status = await call('GET', '/status');
if (!status.exists) {
  console.log(`seeding demo vault on ${w.name}`);
  token = (await call('POST', '', { passphrase: PASS, secondFactor: hw >= 0 ? { cosigner: hw } : null })).session;
  const tpl = async (type) => call('GET', `/templates/${type}`);
  const deedT = await tpl('deed');
  const deedV1 = deedT.content
    .replace('[Describe when and how distributions are made, e.g. ages, milestones, percentages.]', 'Annual distributions of up to 5% of trust assets to each beneficiary from age 25; the remainder at age 35.')
    .replace('[Jurisdiction]', 'State of Arizona, USA (example only)');
  const deed = await call('POST', '/documents', { type: 'deed', title: 'Whitfield Family Bitcoin Trust Agreement', content: deedV1 });
  const v2 = deedV1.replace('## 6. Governing law', '## 5a. Amendment 1 (2026-10-02)\nThe paper backup key is held in a bank safe-deposit box; access requires two trustees.\n\n## 6. Governing law');
  await call('PUT', `/documents/${deed.id}`, { content: v2 });
  await call('POST', `/documents/${deed.id}/versions/1/anchor`, {});
  await call('POST', `/documents/${deed.id}/versions/2/anchor`, {});
  await call('POST', '/documents', { type: 'beneficiaries', title: 'Beneficiaries', content: JSON.stringify([
    { name: 'Avery Whitfield', relationship: 'Daughter', sharePercent: 50, contact: 'avery@example.com', notes: 'Distributions from age 25' },
    { name: 'Mateo Whitfield', relationship: 'Son', sharePercent: 40, contact: 'mateo@example.com', notes: 'Distributions from age 25' },
    { name: 'Desert Botanical Fund', relationship: 'Charity', sharePercent: 10, contact: 'giving@example.org', notes: 'Annual gift' },
  ], null, 2) });
  const tr = JSON.parse((await tpl('trustees')).content).map((r, i) => ({ ...r, contact: ['jordan@example.com', 'safe-deposit box #214', 'trustee@example.com'][i] ?? '' }));
  await call('POST', '/documents', { type: 'trustees', title: 'Trustees & Key Holders', content: JSON.stringify(tr, null, 2) });
  for (const type of ['succession', 'descriptor-backup']) { const t = await tpl(type); await call('POST', '/documents', { type, title: t.title, content: t.content }); }
  await call('POST', '/documents', { type: 'note', title: 'Notary & safe-deposit log', content: '2026-09-28 Deed signed before notary (see attached scan).\n2026-09-30 Paper backup sealed in box #214, two trustees present.\n' });

  // attachments: a small PDF and a PNG "scan" rendered locally
  const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  await call('POST', `/documents/${deed.id}/attachments`, pdf, { 'content-type': 'application/pdf', 'x-filename': 'signed-trust-agreement.pdf' });
  const p = await browser.newPage({ viewport: { width: 360, height: 240 } });
  await p.setContent(`<body style="margin:0;background:#f4efe4;font-family:Georgia;display:grid;place-items:center;height:240px"><div style="text-align:center;color:#3a3020"><div style="font-size:22px">Notarized Signature Page</div><div style="margin:18px 0;font-size:40px;font-family:cursive">J. Whitfield</div><div style="display:inline-block;border:3px solid #b23;color:#b23;border-radius:50%;padding:14px 10px;font-size:12px;transform:rotate(-12deg)">NOTARY · AZ</div></div></body>`);
  const png = await p.screenshot();
  await p.close();
  await call('POST', `/documents/${deed.id}/attachments`, new Uint8Array(png), { 'content-type': 'image/png', 'x-filename': 'notarized-page.png' });
  await call('POST', '/lock', {});
  token = null;
}

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const shot = async (path) => {
  await page.waitForTimeout(1200);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1440, height: Math.max(1000, h) });
  await page.waitForTimeout(500);
  await page.screenshot({ path });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('saved', path);
};

await page.goto(`${UI}/#/vault/${w.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="vault-passphrase"]');
await page.fill('[data-testid="vault-passphrase"]', PASS);
await shot('screenshots/stage4-vault-locked.png');

await page.click('[data-testid="vault-unlock"]');
const r = await Promise.race([
  page.waitForSelector('[data-testid="vault-challenge"]').then(() => 'challenge'),
  page.waitForSelector('[data-testid="vault-unlocked"]').then(() => 'open'),
]);
if (r === 'challenge') { await page.click('[data-testid="vault-sign"]'); await page.waitForSelector('[data-testid="vault-unlocked"]', { timeout: 120000 }); }
await page.click('text=Whitfield Family Bitcoin Trust Agreement');
await page.waitForSelector('[data-testid="anchor-view"]');
await page.waitForSelector('.att-thumb');
await shot('screenshots/stage4-vault.png');
await browser.close();
