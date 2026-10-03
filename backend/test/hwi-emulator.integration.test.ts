import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';
import { HwiCliAdapter } from '../src/hwi.js';

// REAL HWI binary against a running Trezor emulator (scripts/trezor-emu.sh start). Skipped when not available.
const cfg = loadConfig();
const hasEmulator = (() => {
  if (!HwiCliAdapter.available(cfg.hwi.bin)) return false;
  try {
    const out = execFileSync(cfg.hwi.bin, ['--emulators', '--chain', 'regtest', 'enumerate'], { timeout: 20000 }).toString();
    return /simulator/.test(out) && /"fingerprint"/.test(out);
  } catch {
    return false;
  }
})();

describe.skipIf(!hasEmulator)('real HWI + Trezor emulator', () => {
  const rpc = new BitcoinRpc(cfg);
  const app = createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), new HwiCliAdapter({ bin: cfg.hwi.bin, network: 'regtest', emulators: true, timeoutMs: 120000 }));
  const api = () => request(app);
  const BURN = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
  let fp = '';
  let id = '';

  beforeAll(async () => {
    const r = await api().get('/api/devices?refresh=1');
    fp = r.body.find((d: any) => d.emulator && d.fingerprint).fingerprint;
  });

  it('enumerates the emulator through HWI', async () => {
    const st = await api().get('/api/devices/status');
    expect(st.body).toMatchObject({ available: true, mode: 'hwi' });
    expect(st.body.version).toMatch(/^\d+\.\d+/);
    const r = await api().get('/api/devices');
    expect(r.body.some((d: any) => d.type === 'trezor' && /simulator/.test(d.model))).toBe(true);
  });

  it('reads a BIP48 xpub from the device', async () => {
    const r = await api().post(`/api/devices/${fp}/xpub`).send({ purpose: 'multisig' });
    expect(r.status).toBe(200);
    expect(r.body.key).toMatch(new RegExp(`^\\[${fp}/48h/1h/0h/2h\\]tpub`));
  });

  it('Trezor + software cosigner sign a 2-of-3 spend that confirms', async () => {
    const w = await api().post('/api/wallets').send({ name: 'Trezor Vault', type: 'multisig', hardware: [{ fingerprint: fp }] });
    expect(w.status).toBe(201);
    id = w.body.id;
    await api().post('/api/regtest/fund').send({ walletId: id, amount: 2 });
    const p = await api().post(`/api/wallets/${id}/psbt`).send({ outputs: [{ address: BURN, amount: 0.5 }] });
    const s1 = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 0 });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ signatures: 1, signedBy: [fp], signer: { kind: 'hardware' } });
    const s2 = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: s1.body.psbt, cosigner: 2 });
    expect(s2.body.complete).toBe(true);
    const b = await api().post(`/api/wallets/${id}/psbt/broadcast`).send({ psbt: s2.body.psbt });
    expect(b.status).toBe(200);
    await api().post('/api/regtest/mine').send({ blocks: 1 });
    const tx = await rpc.call<{ confirmations: number }>('getrawtransaction', [b.body.txid, true]);
    expect(tx.confirmations).toBe(1);
  });

  it('displays the multisig receive address on the device and it matches', async () => {
    const { address } = (await api().post(`/api/wallets/${id}/address`)).body;
    const v = await api().post(`/api/wallets/${id}/verify-address`).send({ cosigner: 0, address });
    expect(v.status).toBe(200);
    expect(v.body.match).toBe(true);
    expect(v.body.deviceAddress).toMatch(/^tb1q/); // Trezor uses the testnet HRP for regtest
  });

  it('Trezor single-sig (BIP84) wallet signs on device', async () => {
    const w = await api().post('/api/wallets').send({ name: 'Trezor Single', type: 'singlesig', hardware: [{ fingerprint: fp }] });
    expect(w.body.descriptors.receive).toMatch(new RegExp(`^wpkh\\(\\[${fp}/84h/1h/0h\\]`));
    await api().post('/api/regtest/fund').send({ walletId: w.body.id, amount: 1 });
    const p = await api().post(`/api/wallets/${w.body.id}/psbt`).send({ outputs: [{ address: BURN, amount: 0.25 }] });
    const s = await api().post(`/api/wallets/${w.body.id}/psbt/sign`).send({ psbt: p.body.psbt });
    expect(s.body).toMatchObject({ complete: true, signer: { kind: 'hardware', fallback: false } });
    expect((await api().post(`/api/wallets/${w.body.id}/psbt/broadcast`).send({ psbt: s.body.psbt })).status).toBe(200);
  });
});

describe.skipIf(!hasEmulator)('vault second factor on the Trezor emulator', () => {
  const rpc = new BitcoinRpc(cfg);
  const app = createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), new HwiCliAdapter({ bin: cfg.hwi.bin, network: 'regtest', emulators: true, timeoutMs: 120000 }));
  it('Trezor signs the unlock challenge (HWI signmessage) and bitcoind verifies it', async () => {
    const fp = (await request(app).get('/api/devices?refresh=1')).body.find((d: any) => d.fingerprint).fingerprint;
    const w = await request(app).post('/api/wallets').send({ name: 'Trezor 2FA', type: 'multisig', hardware: [{ fingerprint: fp }] });
    const c = await request(app).post(`/api/vaults/${w.body.id}`).send({ passphrase: 'trezor vault passphrase', secondFactor: { cosigner: 0 } });
    expect(c.status).toBe(201);
    const ch = (await request(app).post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: 'trezor vault passphrase' })).body.challenge;
    expect(ch.path).toBe('m/44h/1h/0h/0/0');
    const s = await request(app).post(`/api/vaults/${w.body.id}/unlock/sign`).send({ challengeId: ch.id });
    expect(s.body.signer).toBe('device');
    const v = await request(app).post(`/api/vaults/${w.body.id}/unlock/verify`).send({ challengeId: ch.id, signature: s.body.signature });
    expect(v.status).toBe(200);
  });
});

describe.skipIf(!hasEmulator)('trustee attestation on the Trezor emulator', () => {
  const rpc = new BitcoinRpc(cfg);
  const app = createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), new HwiCliAdapter({ bin: cfg.hwi.bin, network: 'regtest', emulators: true, timeoutMs: 120000 }));
  it('Trezor signs the messaging-key attestation via HWI signmessage', async () => {
    const nacl = (await import('tweetnacl')).default;
    const { newIdentity, signDetached } = await import('../../shared/msgcrypto.js');
    const fp = (await request(app).get('/api/devices?refresh=1')).body.find((d: any) => d.fingerprint).fingerprint;
    const w = await request(app).post('/api/wallets').send({ name: 'Trezor Trustee', type: 'multisig', hardware: [{ fingerprint: fp }] });
    const me = newIdentity(nacl as any, fp);
    const prep = await request(app).post(`/api/messaging/${w.body.id}/identities/prepare`).send({ cosigner: 0, signPub: me.signPub, boxPub: me.boxPub });
    expect(prep.body).toMatchObject({ kind: 'hardware', path: 'm/44h/1h/0h/0/0' });
    const sig = await request(app).post(`/api/messaging/${w.body.id}/identities/sign`).send({ cosigner: 0, statement: prep.body.statement });
    expect(sig.body.signer).toBe('device');
    const r = await request(app).post(`/api/messaging/${w.body.id}/identities`).send({ cosigner: 0, signPub: me.signPub, boxPub: me.boxPub, issuedAt: prep.body.issuedAt, btcSignature: sig.body.signature, popSignature: signDetached(nacl as any, me, prep.body.statement) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'hardware', verified: true, fingerprint: fp });
  });
});
