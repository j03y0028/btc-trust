// Upgrade check for the myNode simulation: `before` runs against the old version, `after` against the new one (same data dir).
//   npx tsx ../scripts/verify-upgrade.mts before|after   (env: SIM, APPPORT)
import { readFileSync, writeFileSync } from 'node:fs';
const SIM = process.env.SIM ?? '/tmp/mynode-sim';
const URL0 = `http://127.0.0.1:${process.env.APPPORT ?? '19330'}`;
const DATA = `${SIM}/mnt/hdd/mynode/btctrust`;
const STATE = `${SIM}/upgrade-state.json`;
const PASS = 'whitfield upgrade passphrase 2026';
let cookie = '';
const api = async (p: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) };
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(init.json); }
  const r = await fetch(URL0 + p, { ...init, headers });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let body: any = t; try { body = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, body };
};
let fail = 0;
const ok = (c: unknown, what: string, extra = '') => { if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${extra ? `  (${extra})` : ''}`); };

if (process.argv[2] === 'before') {
  const token = readFileSync(`${DATA}/app/setup-token`, 'utf8').trim();
  ok((await api('/api/auth/setup', { method: 'POST', json: { passphrase: PASS, setupToken: token } })).status === 201, 'old version: app login set up');
  const w = await api('/api/wallets', { method: 'POST', json: { name: 'Whitfeild Family Trust', type: 'multisig', m: 2, n: 3 } });
  ok(w.status === 201, 'old version: misspelled wallet created', String(w.status));
  const id = w.body.id ?? w.body.wallet?.id ?? w.body.config?.id;
  const d = await api(`/api/wallets/${id}`);
  ok(d.status === 200, 'old version: wallet details');
  const ver = await api('/api/healthz');
  writeFileSync(STATE, JSON.stringify({ id, descriptor: JSON.stringify(d.body.descriptors ?? d.body.config?.descriptors ?? null), healthz: ver.body }));
  console.log('old healthz:', JSON.stringify(ver.body));
} else {
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  console.log('new healthz:', JSON.stringify((await api('/api/healthz')).body));
  ok((await api('/api/auth/status')).body?.configured !== false, 'login still configured after upgrade');
  ok((await api('/api/auth/login', { method: 'POST', json: { passphrase: PASS } })).status === 200, 'same passphrase still signs in after upgrade');
  const list = await api('/api/wallets');
  const arr = Array.isArray(list.body) ? list.body : list.body.wallets;
  const found = arr?.find((x: any) => (x.id ?? x.config?.id) === st.id);
  ok(found, 'wallet created on the old version is still listed', st.id);
  const d = await api(`/api/wallets/${st.id}`);
  ok(d.status === 200, 'wallet details still load (bitcoind wallets on the test node intact)');
  ok(JSON.stringify(d.body.descriptors ?? d.body.config?.descriptors ?? null) === st.descriptor, 'descriptors unchanged');
  const r = await api(`/api/wallets/${st.id}`, { method: 'PATCH', json: { name: 'Whitfield Family Trust' } });
  ok(r.status === 200 && r.body.name === 'Whitfield Family Trust' && r.body.id === st.id, 'new version: rename fixes the typo, id unchanged', JSON.stringify(r.body).slice(0, 120));
  const d2 = await api(`/api/wallets/${st.id}`);
  ok(JSON.stringify(d2.body.descriptors ?? d2.body.config?.descriptors ?? null) === st.descriptor, 'descriptors unchanged after rename');
  const t = await api('/api/wallets', { method: 'POST', json: { name: 'Throwaway Test', type: 'singlesig' } });
  const tid = t.body.id ?? t.body.wallet?.id ?? t.body.config?.id;
  const chk = await api(`/api/wallets/${tid}/delete-check`);
  ok(chk.status === 200 && chk.body.deletable === true, 'delete-check on the bundled regtest node', JSON.stringify(chk.body).slice(0, 160));
  ok((await api(`/api/wallets/${tid}`, { method: 'DELETE', json: { confirmName: 'wrong' } })).status === 400, 'delete refused without the exact name');
  const del = await api(`/api/wallets/${tid}`, { method: 'DELETE', json: { confirmName: 'Throwaway Test' } });
  ok(del.status === 200, 'delete of a throwaway test wallet', JSON.stringify(del.body).slice(0, 200));
  ok((await api(`/api/wallets/${tid}`)).status === 404, 'deleted wallet is gone (404)');
  ok((await api(`/api/wallets/${st.id}`)).status === 200, 'other wallet untouched by the delete');
  if (process.env.CHECK_PRICES !== '0') {
    const p = await api('/api/prices?currency=USD');
    ok(p.status === 200 && (p.body.available === true ? /^[1-9]\d+$/.test(p.body.priceE8) : typeof p.body.error === 'string'), 'price endpoint answers from inside the container', JSON.stringify(p.body).slice(0, 160));
    if (p.body.available) console.log(`      1 BTC = ${p.body.price} USD via ${p.body.source}`);
    ok((await api('/api/settings/display')).body?.fiat === 'USD', 'display defaults to USD after upgrade');
    ok((await api('/api/settings/display', { method: 'PUT', json: { fiat: 'EUR', unit: 'sats' } })).status === 200, 'display choice saved');
    ok((await api('/api/settings/display', { method: 'PUT', json: { fiat: 'EUR' }, headers: { origin: 'https://evil.example' } })).status === 403, 'cross-site settings write blocked');
    ok((await api('/api/prices?currency=XYZ')).status === 400, 'unknown currency refused');
  }
}
console.log(fail ? `${fail} FAILED` : 'ALL PASSED'); process.exit(fail ? 1 : 0);
