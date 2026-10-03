import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';
import { MockHwiAdapter } from '../src/hwi-mock.js';

// Hardware-wallet flows against the MOCK HWI adapter (always available). The real Trezor emulator suite is hwi-emulator.integration.test.ts.
const cfg = loadConfig();
const rpc = new BitcoinRpc(cfg);
const mock = new MockHwiAdapter(rpc, 'btctrust-mock-device-test', 'Mock Trezor');
const store = new WalletStore(cfg.dataDir, cfg.network);
const app = createApp(cfg, rpc, store, mock);
const noHwi = createApp(cfg, rpc, store, null);
const api = () => request(app);
const BURN = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const fund = (walletId: string, amount: number) => api().post('/api/regtest/fund').send({ walletId, amount });
const setConnected = async (on: boolean) => {
  mock.connected = on;
  await api().get('/api/devices?refresh=1');
};

let fp = '';
let msId = '';

beforeAll(async () => {
  await setConnected(true);
});

describe('device enumeration & xpub (mock adapter)', () => {
  it('reports HWI status and lists the device', async () => {
    expect((await api().get('/api/devices/status')).body).toMatchObject({ available: true, mode: 'mock' });
    const r = await api().get('/api/devices?refresh=1');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ type: 'mock', label: 'Mock Trezor', error: null });
    fp = r.body[0].fingerprint;
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns a key expression with key origin for the device', async () => {
    const r = await api().post(`/api/devices/${fp}/xpub`).send({ purpose: 'multisig' });
    expect(r.status).toBe(200);
    expect(r.body.key).toMatch(new RegExp(`^\\[${fp}/[0-9h/]+\\]tpub[1-9A-HJ-NP-Za-km-z]+/0/\\*$`));
    expect((await api().post('/api/devices/deadbeef/xpub').send({})).status).toBe(409);
    expect((await api().post(`/api/devices/${fp}/xpub`).send({ purpose: 'bogus' })).status).toBe(400);
  });

  it('without HWI configured, devices list is empty and status says unavailable', async () => {
    expect((await request(noHwi).get('/api/devices')).body).toEqual([]);
    expect((await request(noHwi).get('/api/devices/status')).body).toMatchObject({ available: false });
  });
});

describe('hardware cosigner in 2-of-3 multisig', () => {
  it('imports the device xpub as a cosigner', async () => {
    const r = await api().post('/api/wallets').send({ name: 'HW Vault', type: 'multisig', m: 2, n: 3, hardware: [{ fingerprint: fp }], cosignerLabels: ['Trezor', 'Jordan laptop', 'Backup'] });
    expect(r.status).toBe(201);
    msId = r.body.id;
    expect(r.body.cosigners.map((c: any) => c.kind)).toEqual(['hardware', 'software', 'software']);
    expect(r.body.cosigners[0]).toMatchObject({ fingerprint: fp, label: 'Trezor', local: false, device: { type: 'mock' } });
    expect(r.body.descriptors.receive).toContain(`[${fp}/`);
    expect(r.body).toMatchObject({ canSign: true, signable: true });
    // duplicate hardware key rejected; mismatched origin rejected
    expect((await api().post('/api/wallets').send({ name: 'dup', type: 'multisig', hardware: [{ fingerprint: fp }, { fingerprint: fp }] })).status).toBe(400);
    expect((await api().post('/api/wallets').send({ name: 'bad', type: 'multisig', hardware: [{ fingerprint: 'deadbeef', key: r.body.cosigners[0].key }] })).status).toBe(400);
  });

  it('signs with device + software cosigner to 2/2 and broadcasts', async () => {
    await fund(msId, 3);
    const p = await api().post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.4 }] });
    const s1 = await api().post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 0 });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ signatures: 1, signedBy: [fp], signer: { index: 0, kind: 'hardware', fallback: false } });
    const s2 = await api().post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: s1.body.psbt, cosigner: 1 });
    expect(s2.body).toMatchObject({ signatures: 2, complete: true, signer: { kind: 'software' } });
    const b = await api().post(`/api/wallets/${msId}/psbt/broadcast`).send({ psbt: s2.body.psbt });
    expect(b.status).toBe(200);
    expect(await rpc.call<string[]>('getrawmempool')).toContain(b.body.txid);
  });

  it('auto-sign prefers the connected hardware wallet', async () => {
    const p = await api().post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.1 }] });
    const s = await api().post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: p.body.psbt });
    expect(s.body.signer).toMatchObject({ index: 0, kind: 'hardware', fallback: false });
  });

  it('verifies a receive address on the device', async () => {
    const { address } = (await api().post(`/api/wallets/${msId}/address`)).body;
    const v = await api().post(`/api/wallets/${msId}/verify-address`).send({ cosigner: 0, address });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ match: true, expected: address });
    expect((await api().post(`/api/wallets/${msId}/verify-address`).send({ cosigner: 1, address })).status).toBe(400);
    expect((await api().post(`/api/wallets/${msId}/verify-address`).send({ cosigner: 0, address: BURN })).status).toBe(400);
  });
});

describe('air-gapped PSBT file round trip', () => {
  it('exports binary .psbt and imports binary, base64 and hex', async () => {
    const p = await api().post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.2 }] });
    const ex = await api().post(`/api/wallets/${msId}/psbt/export`).send({ psbt: p.body.psbt }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(ex.status).toBe(200);
    expect(ex.headers['content-disposition']).toMatch(/attachment; filename=".*0of2\.psbt"/);
    const bytes: Buffer = ex.body;
    expect(bytes.subarray(0, 5).toString('hex')).toBe('70736274ff');
    expect(bytes.toString('base64')).toBe(p.body.psbt);

    const bin = await api().post(`/api/wallets/${msId}/psbt/import`).set('content-type', 'application/octet-stream').send(bytes);
    expect(bin.status).toBe(200);
    expect(bin.body).toMatchObject({ psbt: p.body.psbt, txid: p.body.txid, signatures: 0 });
    const txt = await api().post(`/api/wallets/${msId}/psbt/import`).set('content-type', 'text/plain').send(`  ${p.body.psbt}\n`);
    expect(txt.body.txid).toBe(p.body.txid);
    const hex = await api().post(`/api/wallets/${msId}/psbt/import`).send({ psbt: bytes.toString('hex') });
    expect(hex.body.txid).toBe(p.body.txid);
  });

  it('merges a PSBT signed elsewhere (air-gapped device) into the in-progress one', async () => {
    const p = await api().post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.15 }] });
    // Simulate the air-gapped device: it signs a copy of the file out-of-band.
    const [dev] = await mock.enumerate();
    const signedElsewhere = Buffer.from(await mock.signPsbt(dev, p.body.psbt), 'base64');
    const local = await api().post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 2 });
    const merged = await api().post(`/api/wallets/${msId}/psbt/import`).query({ base: local.body.psbt }).set('content-type', 'application/octet-stream').send(signedElsewhere);
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ signatures: 2, complete: true });
    expect((await api().post(`/api/wallets/${msId}/psbt/broadcast`).send({ psbt: merged.body.psbt })).status).toBe(200);
  });

  it('rejects garbage and PSBTs for a different transaction', async () => {
    const a = await api().post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.01 }] });
    const b = await api().post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.02 }] });
    expect((await api().post(`/api/wallets/${msId}/psbt/import`).send({ psbt: b.body.psbt, base: a.body.psbt })).status).toBe(400);
    expect((await api().post(`/api/wallets/${msId}/psbt/import`).set('content-type', 'text/plain').send('not a psbt')).status).toBe(400);
    expect((await api().post(`/api/wallets/${msId}/psbt/export`).send({ psbt: 'aGVsbG8=' })).status).toBe(400);
  });
});

describe('software fallback when no device is connected', () => {
  it('refuses to silently swap signers, then falls back when asked', async () => {
    await setConnected(false);
    expect((await api().get('/api/devices?refresh=1')).body).toEqual([]);
    const p = await api().post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.05 }] });
    const no = await api().post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 0 });
    expect(no.status).toBe(409);
    expect(no.body.details).toMatchObject({ code: 'DEVICE_NOT_CONNECTED', fallbackAvailable: true });
    const fb = await api().post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 0, fallback: true });
    expect(fb.status).toBe(200);
    expect(fb.body.signer).toMatchObject({ kind: 'software', fallback: true, index: 1 });
    expect(fb.body.signer.reason).toMatch(/not connected/);
    const auto = await api().post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: fb.body.psbt });
    expect(auto.body).toMatchObject({ signatures: 2, complete: true, signer: { kind: 'software', index: 2, fallback: true } });
    expect((await api().post(`/api/wallets/${msId}/psbt/broadcast`).send({ psbt: auto.body.psbt })).status).toBe(200);
    await setConnected(true);
  });

  it('works with HWI not installed at all', async () => {
    const p = await request(noHwi).post(`/api/wallets/${msId}/psbt`).send({ outputs: [{ address: BURN, amount: 0.05 }] });
    const s = await request(noHwi).post(`/api/wallets/${msId}/psbt/sign`).send({ psbt: p.body.psbt });
    expect(s.body.signer).toMatchObject({ kind: 'software', fallback: true });
  });
});

describe('hardware single-sig wallet', () => {
  it('creates a watch-only wpkh wallet signed by the device, with no software fallback', async () => {
    const r = await api().post('/api/wallets').send({ name: 'HW Single', type: 'singlesig', hardware: [{ fingerprint: fp }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'singlesig', m: 1, n: 1, canSign: false, signable: true });
    expect(r.body.cosigners[0].kind).toBe('hardware');
    expect(r.body.descriptors.receive).toMatch(new RegExp(`^wpkh\\(\\[${fp}/`));
    const info = await rpc.call<{ private_keys_enabled: boolean }>('getwalletinfo', [], r.body.watchWallet);
    expect(info.private_keys_enabled).toBe(false);
    await fund(r.body.id, 1);
    const p = await api().post(`/api/wallets/${r.body.id}/psbt`).send({ outputs: [{ address: BURN, amount: 0.3 }] });
    const s = await api().post(`/api/wallets/${r.body.id}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 0 });
    expect(s.body).toMatchObject({ complete: true, signer: { kind: 'hardware' } });
    expect((await api().post(`/api/wallets/${r.body.id}/psbt/broadcast`).send({ psbt: s.body.psbt })).status).toBe(200);

    await setConnected(false);
    const p2 = await api().post(`/api/wallets/${r.body.id}/psbt`).send({ outputs: [{ address: BURN, amount: 0.1 }] });
    const s2 = await api().post(`/api/wallets/${r.body.id}/psbt/sign`).send({ psbt: p2.body.psbt, cosigner: 0, fallback: true });
    expect(s2.status).toBe(409);
    expect(s2.body.details.code).toBe('NO_FALLBACK');
    await setConnected(true);
  });
});
