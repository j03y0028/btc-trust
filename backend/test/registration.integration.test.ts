import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';
import { HwiCliAdapter } from '../src/hwi.js';
import { coldcardToDescriptor, parseColdcardMultisig } from '../src/registration/coldcard.js';

// Regtest bitcoind required. The Trezor part uses the REAL HWI + Trezor emulator and is skipped when it is not running.
const cfg = loadConfig();
const rpc = new BitcoinRpc(cfg);
const hasEmulator = (() => {
  if (!HwiCliAdapter.available(cfg.hwi.bin)) return false;
  try { return /simulator/.test(execFileSync(cfg.hwi.bin, ['--emulators', '--chain', 'regtest', 'enumerate'], { timeout: 20000 }).toString()); } catch { return false; }
})();

describe('multisig registration (regtest)', () => {
  const app = createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), null);
  it('Coldcard file encodes exactly the wallet bitcoind tracks (same descriptor checksum)', async () => {
    const w = await request(app).post('/api/wallets').send({ name: 'Coldcard Reg Test', type: 'multisig' });
    expect(w.status).toBe(201);
    const r = await request(app).get(`/api/wallets/${w.body.id}/registration/coldcard`);
    expect(r.status).toBe(200);
    const desc = coldcardToDescriptor(parseColdcardMultisig(r.body.text));
    const [ours, node] = await Promise.all([
      rpc.call<{ checksum: string }>('getdescriptorinfo', [desc]),
      rpc.call<{ checksum: string }>('getdescriptorinfo', [w.body.descriptors.receive.replace(/#.*/, '')]),
    ]);
    expect(ours.checksum).toBe(node.checksum);
    const file = await request(app).get(`/api/wallets/${w.body.id}/registration/coldcard.txt`);
    expect(file.headers['content-disposition']).toMatch(/attachment; filename="Coldcard-Reg-Test-coldcard.txt"/);
    const strip = (t: string) => t.replace(/^# Exported: .*\n/m, '');
    expect(strip(file.text)).toBe(strip(r.body.text));
    // first address derived from the Coldcard-file descriptor equals the wallet's address 0
    const fromFile = await rpc.call<string[]>('deriveaddresses', [`${desc}#${ours.checksum}`, [0, 0]]);
    const fromWallet = await rpc.call<string[]>('deriveaddresses', [w.body.descriptors.receive, [0, 0]]);
    expect(fromFile).toEqual(fromWallet);
  });
  it('Ledger (mock adapter) registration stores the HMAC and verifies it', async () => {
    const w = await request(app).post('/api/wallets').send({ name: 'Ledger Reg Test', type: 'multisig' });
    const r = await request(app).post(`/api/wallets/${w.body.id}/registration/ledger`).send({ cosigner: 1 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ device: 'ledger', mock: true, hmac: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const v = await request(app).get(`/api/wallets/${w.body.id}/registration/ledger/1/verify`);
    expect(v.body).toEqual({ policyId: r.body.policyId, sameId: true, hmacValid: true });
    const single = await request(app).post('/api/wallets').send({ name: 'Single', type: 'singlesig' });
    expect((await request(app).get(`/api/wallets/${single.body.id}/registration`)).status).toBe(400);
  });
});

describe.skipIf(!hasEmulator)('Trezor: no registration needed (real HWI + emulator)', () => {
  const app = createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), new HwiCliAdapter({ bin: cfg.hwi.bin, network: 'regtest', emulators: true, timeoutMs: 120000 }));
  it('reports not-required for the connected Trezor and refuses a Ledger-style registration on it', async () => {
    const devs = await request(app).get('/api/devices?refresh=1');
    const fp = devs.body.find((d: any) => d.emulator && d.fingerprint).fingerprint;
    const w = await request(app).post('/api/wallets').send({ name: 'Trezor Reg Test', type: 'multisig', hardware: [{ fingerprint: fp }] });
    expect(w.status).toBe(201);
    const st = await request(app).get(`/api/wallets/${w.body.id}/registration`);
    const t = st.body.cosigners.find((c: any) => c.fingerprint === fp);
    expect(t).toMatchObject({ deviceType: 'trezor', trezor: { required: false }, connected: { type: 'trezor' } });
    expect(t.connected.model).toMatch(/simulator/);
    const reg = await request(app).post(`/api/wallets/${w.body.id}/registration/ledger`).send({ cosigner: 0 });
    expect(reg.status).toBe(400);
    expect(reg.body.error).toMatch(/Trezor/);
  });
});
