// Captures screenshots/stage5-messages.png and stage5-sigrequest.png.
// Run with: npm run screenshot:stage5 (needs dev servers). Seeds demo trustee identities and an encrypted conversation
// on the first all-software 2-of-3 wallet (regtest only). The demo trustees' secret keys are saved to
// data/demo-trustee-keys.json (gitignored) and injected into the browser keyring, standing in for each trustee's device.
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import nacl from '../backend/node_modules/tweetnacl/nacl-fast.js';
import { authToken, newIdentity, sealMessage, signDetached, signReceipt, type Body, type Nacl, type SecretIdentity } from '../shared/msgcrypto.ts';

const N = nacl as unknown as Nacl;
const UI = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:5173';
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const KEYS = 'data/demo-trustee-keys.json';

const j = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${API}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${d.error}`);
  return d;
};
const wallets = await j('GET', '/api/wallets');
const w = wallets.find((x: any) => x.type === 'multisig' && x.n === 3 && x.cosigners.every((c: any) => c.kind === 'software'));
if (!w) throw new Error('Need a 2-of-3 software multisig (npm run seed)');
const W = w.id;
const ring: Record<string, SecretIdentity> = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8'))[W] ?? {} : {};
const dir = await j('GET', `/api/messaging/${W}/directory`);
const fps: string[] = w.cosigners.map((c: any) => c.fingerprint);
const auth = (me: SecretIdentity) => ({ 'x-trustee-auth': authToken(N, W, me) });

const fresh = dir.some((d: any) => !d.identity || d.identity.signPub !== ring[d.fingerprint]?.signPub);
if (fresh) {
  console.log(`seeding trustee channel on ${w.name}`);
  for (const [i, fp] of fps.entries()) {
    const me = newIdentity(N, fp);
    const prep = await j('POST', `/api/messaging/${W}/identities/prepare`, { cosigner: i, signPub: me.signPub, boxPub: me.boxPub });
    const sig = await j('POST', `/api/messaging/${W}/identities/sign`, { cosigner: i, statement: prep.statement });
    await j('POST', `/api/messaging/${W}/identities`, { cosigner: i, signPub: me.signPub, boxPub: me.boxPub, issuedAt: prep.issuedAt, btcSignature: sig.signature, popSignature: signDetached(N, me, prep.statement) });
    ring[fp] = me;
  }
  const all = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : {};
  writeFileSync(KEYS, JSON.stringify({ ...all, [W]: ring }, null, 2));
  const [jordan, trustee, backup] = fps.map((f) => ring[f]);
  const members = [jordan, trustee, backup];
  const say = (me: SecretIdentity, body: Body, urgent = false, threadId = 'group') =>
    j('POST', `/api/messaging/${W}/threads/${encodeURIComponent(threadId)}/messages`, sealMessage(N, { me, walletId: W, threadId, recipients: threadId === 'group' ? members : members.filter((m) => threadId.includes(m.fingerprint)), body, urgent }), auth(me));
  const read = (me: SecretIdentity, upToSeq: number, threadId = 'group') => j('POST', `/api/messaging/${W}/threads/${encodeURIComponent(threadId)}/read`, signReceipt(N, me, { walletId: W, threadId, upToSeq, at: new Date().toISOString() }), auth(me));

  let m = await say(trustee, { type: 'text', text: 'Morning both. The Q4 distribution to Mateo (0.5 BTC) is due Friday per section 4 of the trust agreement. I will prepare the PSBT.' });
  await read(jordan, m.seq); await read(backup, m.seq);
  m = await say(jordan, { type: 'text', text: 'Sounds good. I reviewed the beneficiary schedule in the vault last night, so the amount matches.' });
  await read(trustee, m.seq); await read(backup, m.seq);
  m = await say(backup, { type: 'text', text: 'I hold the paper backup key at the bank, so I only need to come in if one of you cannot sign.' });
  await read(jordan, m.seq); await read(trustee, m.seq);
  // signature request linked to a real PSBT
  const spend = wallets.find((x: any) => x.type === 'singlesig');
  const dest = (await j('POST', `/api/wallets/${spend.id}/address`)).address;
  const psbt = await j('POST', `/api/wallets/${W}/psbt`, { outputs: [{ address: dest, amount: 0.5 }] });
  const req = await j('POST', `/api/messaging/${W}/sigrequests`, { psbt: psbt.psbt, threadId: 'group', requestedFrom: [jordan.fingerprint, backup.fingerprint] }, auth(trustee));
  await say(trustee, { type: 'sigreq', requestId: req.id, txid: req.txid, summary: '0.5 BTC to Mateo', text: 'Q4 distribution to Mateo. I have signed; one more signature needed.' });
  const s1 = await j('POST', `/api/messaging/${W}/sigrequests/${req.id}/sign`, {}, auth(trustee));
  m = await say(trustee, { type: 'sigreq-update', requestId: req.id, action: 'signed', text: `Signed (${s1.signatures}/${s1.required})`, signatures: s1.signatures, required: s1.required });
  await read(backup, m.seq);
  m = await say(backup, { type: 'text', text: 'URGENT: the bank called. Safe-deposit access rules change Monday, and two trustees must be present to update the signature card. Please call me today.' }, true);
  await say(jordan, { type: 'text', text: 'Can you resend the box number privately?' }, false, `dm:${[jordan.fingerprint, backup.fingerprint].sort().join(':')}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const keyring = Object.fromEntries([[W, Object.fromEntries(Object.values(ring).map((id) => [id.fingerprint, { current: id, previous: [] }]))]]);
// Seed the demo keys once as a legacy v1 keyring; the app then migrates them to the encrypted v2 store (Stage 7).
await page.addInitScript(([k, a]) => { if (!localStorage.getItem('btctrust-trustee-keys-v2')) localStorage.setItem('btctrust-trustee-keys-v1', k); localStorage.setItem('btctrust-acting-v1', a); }, [JSON.stringify(keyring), JSON.stringify({ [W]: fps[0] })]);
const shot = async (path: string) => {
  await page.waitForTimeout(1200);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1440, height: Math.max(1000, h) });
  await page.waitForTimeout(600);
  await page.screenshot({ path });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('saved', path);
};
await page.goto(`${UI}/#/messages/${W}`, { waitUntil: 'networkidle' });
const PASS = 'demo keyring passphrase';
if (await page.locator('[data-testid="keygate-legacy"]').isVisible()) {
  await page.fill('#kg-pass', PASS); await page.fill('#kg-confirm', PASS); await page.click('text=Encrypt & migrate');
} else if (await page.locator('[data-testid="keygate-locked"]').isVisible()) {
  await page.fill('#kg-pass', PASS); await page.click('button:has-text("Unlock")');
}
await page.waitForSelector('[data-testid="sigreq-card"] [data-testid="sigreq-status"]');
await page.waitForSelector('.live-pill.live');
await page.evaluate(() => { const s = document.querySelector('.chat-scroll'); if (s) (s as HTMLElement).style.maxHeight = 'none'; });
await page.waitForSelector('[data-testid="urgent-banner"]');
await shot('screenshots/stage5-messages.png');

// Jordan signs from the card: 1/2 → 2/2, the status line and timeline update live
await page.click('[data-testid="sigreq-sign"]');
await page.waitForSelector('text=Ready to broadcast · 2/2');
await page.click('text=Review PSBT');
await page.waitForTimeout(800);
// full-height viewport so element boxes are page coordinates, then crop to the card and its status lines
const fullH = await page.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width: 1440, height: fullH });
await page.waitForTimeout(600);
const box = (await (await page.$('[data-testid="sigreq-card"]'))!.boundingBox())!;
const chat = (await (await page.$('[data-testid="chat"]'))!.boundingBox())!;
const y = Math.max(0, box.y - 70);
await page.screenshot({ path: 'screenshots/stage5-sigrequest.png', clip: { x: chat.x, y, width: chat.width, height: Math.min(fullH - y, box.height + 190) } });
console.log('saved screenshots/stage5-sigrequest.png');
await browser.close();
