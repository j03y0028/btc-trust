// Seed demo REGTEST wallets through the API (dev servers must be running).
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const post = async (p, b = {}) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
};
const get = async (p) => (await fetch(API + p)).json();

const existing = await get('/api/wallets');
if (existing.length) { console.log(JSON.stringify({ seeded: false, wallets: existing.map((w) => [w.id, w.name]) })); process.exit(0); }

const vault = await post('/api/wallets', { name: 'Family Trust Vault', type: 'multisig', m: 2, n: 3, cosignerLabels: ['Jordan', 'Trustee', 'Backup'] });
const spend = await post('/api/wallets', { name: 'Everyday Spending', type: 'singlesig', cosignerLabels: ['Jordan'] });
const board = await post('/api/wallets', { name: 'Board Reserve', type: 'multisig', m: 3, n: 5, cosignerLabels: ['Jordan', 'Ana', 'Marcus', 'Lee', 'Vault Co.'] });
await post('/api/wallets', { name: 'Auditor View', type: 'watchonly', descriptor: vault.descriptors.receive });

await post('/api/regtest/fund', { walletId: vault.id, amount: 12.5 });
await post('/api/regtest/fund', { walletId: vault.id, amount: 8.25 });
await post('/api/regtest/fund', { walletId: spend.id, amount: 1.2 });
await post('/api/regtest/fund', { walletId: board.id, amount: 21 });
// One 2-of-3 spend from the vault to the spending wallet, signed by Jordan + Trustee.
const to = (await post(`/api/wallets/${spend.id}/address`)).address;
let p = await post(`/api/wallets/${vault.id}/psbt`, { outputs: [{ address: to, amount: 0.75 }], feeRate: 3 });
p = await post(`/api/wallets/${vault.id}/psbt/sign`, { psbt: p.psbt, cosigner: 0 });
p = await post(`/api/wallets/${vault.id}/psbt/sign`, { psbt: p.psbt, cosigner: 1 });
await post(`/api/wallets/${vault.id}/psbt/broadcast`, { psbt: p.psbt });
await post('/api/regtest/mine', { blocks: 2 });
console.log(JSON.stringify({ seeded: true, vault: vault.id, spend: spend.id }));
