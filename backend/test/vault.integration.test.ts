import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';
import { MockHwiAdapter } from '../src/hwi-mock.js';

const cfg = loadConfig();
const rpc = new BitcoinRpc(cfg);
const store = new WalletStore(cfg.dataDir, cfg.network);
const mock = new MockHwiAdapter(rpc, 'btctrust-mock-device-test', 'Mock Trezor');
const app = createApp(cfg, rpc, store, mock);
const api = () => request(app);
const PASS = 'correct horse battery staple';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\nSECRET-PDF-BODY');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake-png-SECRET-IMG')]);
const vaultFile = (id: string) => join(cfg.dataDir, 'vaults', `${id}.vault.json`);
const attFiles = (id: string) => readdirSync(join(cfg.dataDir, 'vaults', id)).map((f) => join(cfg.dataDir, 'vaults', id, f));
const as = (token: string) => ({ 'x-vault-session': token });
const unlock = async (id: string, passphrase = PASS) => (await api().post(`/api/vaults/${id}/unlock`).send({ passphrase })).body.session as string;

let walletId = '';
let token = '';
let deedId = '';
let attId = '';

beforeAll(async () => {
  const w = await api().post('/api/wallets').send({ name: 'Vault Test Trust', type: 'multisig', cosignerLabels: ['Jordan', 'Trustee', 'Backup'] });
  walletId = w.body.id;
});

describe('vault lifecycle', () => {
  it('creates a vault (rejects short passphrases) and starts unlocked', async () => {
    expect((await api().get(`/api/vaults/${walletId}/status`)).body).toMatchObject({ exists: false, unlocked: false });
    expect((await api().post(`/api/vaults/${walletId}`).send({ passphrase: 'short' })).status).toBe(400);
    const r = await api().post(`/api/vaults/${walletId}`).send({ passphrase: PASS });
    expect(r.status).toBe(201);
    token = r.body.session;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await api().post(`/api/vaults/${walletId}`).send({ passphrase: PASS })).status).toBe(409);
    const st = (await api().get(`/api/vaults/${walletId}/status`).set(as(token))).body;
    expect(st).toMatchObject({ exists: true, unlocked: true, cipher: 'AES-256-GCM', kdf: { name: 'scrypt', r: 8, p: 1 }, secondFactor: null });
  });

  it('creates documents from templates with SHA-256 versioning', async () => {
    const t = (await api().get(`/api/vaults/${walletId}/templates/deed`).set(as(token))).body;
    expect(t.content).toMatch(/NOT legal/);
    const d = await api().post(`/api/vaults/${walletId}/documents`).set(as(token)).send({ type: 'deed', title: t.title, content: t.content + '\nBeneficiary: SECRET-BENEFICIARY-ALICE' });
    expect(d.status).toBe(201);
    deedId = d.body.id;
    expect(d.body.versions[0]).toMatchObject({ v: 1, verified: true });
    expect(d.body.versions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const u = await api().put(`/api/vaults/${walletId}/documents/${deedId}`).set(as(token)).send({ content: d.body.versions[0].content + '\nAmendment 1' });
    expect(u.body.versions).toHaveLength(2);
    expect(u.body.versions[1].sha256).not.toBe(u.body.versions[0].sha256);
    const same = await api().put(`/api/vaults/${walletId}/documents/${deedId}`).set(as(token)).send({ content: u.body.versions[1].content });
    expect(same.body.versions).toHaveLength(2); // unchanged content does not create a version
    expect((await api().get(`/api/vaults/${walletId}/documents/${deedId}/versions/2/verify`).set(as(token))).body).toMatchObject({ valid: true });
    for (const type of ['beneficiaries', 'trustees', 'succession', 'descriptor-backup', 'note']) {
      const tt = (await api().get(`/api/vaults/${walletId}/templates/${type}`).set(as(token))).body;
      const r = await api().post(`/api/vaults/${walletId}/documents`).set(as(token)).send({ type, title: tt.title, content: tt.content });
      expect(r.status).toBe(201);
    }
    const list = (await api().get(`/api/vaults/${walletId}/documents`).set(as(token))).body;
    expect(list.map((x: any) => x.type).sort()).toEqual(['beneficiaries', 'deed', 'descriptor-backup', 'note', 'succession', 'trustees']);
  });

  it('refuses private keys and malformed structured documents', async () => {
    const tprv = 'tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK';
    expect((await api().post(`/api/vaults/${walletId}/documents`).set(as(token)).send({ type: 'descriptor-backup', title: 'x', content: `wpkh(${tprv}/0/*)` })).status).toBe(400);
    expect((await api().post(`/api/vaults/${walletId}/documents`).set(as(token)).send({ type: 'beneficiaries', title: 'x', content: 'not json' })).status).toBe(400);
    expect((await api().post(`/api/vaults/${walletId}/documents`).set(as(token)).send({ type: 'bogus', content: '' })).status).toBe(400);
  });

  it('stores encrypted attachments (PDF/images) and validates file type', async () => {
    const a = await api().post(`/api/vaults/${walletId}/documents/${deedId}/attachments`).set(as(token)).set('content-type', 'application/pdf').set('x-filename', 'signed-deed.pdf').send(PDF);
    expect(a.status).toBe(201);
    attId = a.body.id;
    expect(a.body).toMatchObject({ name: 'signed-deed.pdf', mime: 'application/pdf', size: PDF.length });
    const img = await api().post(`/api/vaults/${walletId}/documents/${deedId}/attachments`).set(as(token)).set('content-type', 'image/png').set('x-filename', 'id.png').send(PNG);
    expect(img.status).toBe(201);
    const dl = await api().get(`/api/vaults/${walletId}/documents/${deedId}/attachments/${attId}`).set(as(token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(dl.headers['content-type']).toMatch(/application\/pdf/);
    expect((dl.body as Buffer).equals(PDF)).toBe(true);
    expect((await api().post(`/api/vaults/${walletId}/documents/${deedId}/attachments`).set(as(token)).set('content-type', 'application/pdf').send(Buffer.from('not a pdf'))).status).toBe(415);
    expect((await api().post(`/api/vaults/${walletId}/documents/${deedId}/attachments`).set(as(token)).set('content-type', 'application/zip').send(Buffer.from('PK..'))).status).toBe(415);
  });

  it('keeps only ciphertext on disk', () => {
    const raw = readFileSync(vaultFile(walletId), 'utf8');
    const v = JSON.parse(raw);
    expect(v).toMatchObject({ format: 'btctrust-vault', kdf: { name: 'scrypt' } });
    for (const needle of ['SECRET-BENEFICIARY-ALICE', 'Trust Agreement', 'Amendment', 'signed-deed.pdf', 'NOT legal', 'sortedmulti']) expect(raw).not.toContain(needle);
    for (const f of attFiles(walletId)) {
      const bytes = readFileSync(f);
      expect(bytes.includes(Buffer.from('%PDF'))).toBe(false);
      expect(bytes.includes(Buffer.from('SECRET'))).toBe(false);
      expect(bytes.includes(Buffer.from('89504e47', 'hex'))).toBe(false);
    }
  });

  it('locks, rejects the wrong passphrase, and unlocks with the right one', async () => {
    await api().post(`/api/vaults/${walletId}/lock`).set(as(token));
    expect((await api().get(`/api/vaults/${walletId}/documents`).set(as(token))).status).toBe(401);
    expect((await api().get(`/api/vaults/${walletId}/documents`)).body.details.code).toBe('VAULT_LOCKED');
    const bad = await api().post(`/api/vaults/${walletId}/unlock`).send({ passphrase: 'correct horse battery stapl' });
    expect(bad.status).toBe(401);
    expect(bad.body.details.code).toBe('WRONG_PASSPHRASE');
    token = await unlock(walletId);
    expect((await api().get(`/api/vaults/${walletId}/documents`).set(as(token))).status).toBe(200);
  });
});

describe('integrity & tamper detection', () => {
  it('detects a modified encrypted index', async () => {
    const f = vaultFile(walletId);
    const orig = readFileSync(f, 'utf8');
    const v = JSON.parse(orig);
    const ct = Buffer.from(v.index.ct, 'base64'); ct[10] ^= 0x01;
    writeFileSync(f, JSON.stringify({ ...v, index: { ...v.index, ct: ct.toString('base64') } }));
    const r = await api().post(`/api/vaults/${walletId}/unlock`).send({ passphrase: PASS });
    expect(r.status).toBe(422);
    expect(r.body.details.code).toBe('TAMPERED');
    writeFileSync(f, orig);
  });

  it('detects stripping the second-factor setting from the file', async () => {
    const f = vaultFile(walletId);
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(orig), secondFactor: { cosigner: 0, label: 'x', kind: 'software', fingerprint: '00000000', address: 'mxx', path: 'm' } }));
    expect((await api().post(`/api/vaults/${walletId}/unlock`).send({ passphrase: PASS })).status).toBe(422);
    writeFileSync(f, orig);
  });

  it('detects a modified attachment', async () => {
    const f = join(cfg.dataDir, 'vaults', walletId, `${attId}.bin`);
    const orig = readFileSync(f);
    const t = Buffer.from(orig); t[t.length - 3] ^= 0xff;
    writeFileSync(f, t);
    const r = await api().get(`/api/vaults/${walletId}/documents/${deedId}/attachments/${attId}`).set(as(token));
    expect(r.status).toBe(422);
    writeFileSync(f, orig);
    expect((await api().get(`/api/vaults/${walletId}/documents/${deedId}/attachments/${attId}`).set(as(token))).status).toBe(200);
  });
});

describe('anchoring on regtest', () => {
  it('anchors a version hash via OP_RETURN and verifies it', async () => {
    const r = await api().post(`/api/vaults/${walletId}/documents/${deedId}/versions/2/anchor`).set(as(token)).send({});
    expect(r.status).toBe(200);
    const tip = await rpc.call<number>('getblockcount');
    const hash = (await api().get(`/api/vaults/${walletId}/documents/${deedId}`).set(as(token))).body.versions[1].sha256;
    expect(r.body).toMatchObject({ valid: true, onChain: true, contentOk: true, height: tip, confirmations: 1, hash });
    expect(r.body.opReturn).toBe(`42545631${hash}`);
    const tx = await rpc.call<any>('getrawtransaction', [r.body.txid, true]);
    expect(tx.vout.some((o: any) => o.scriptPubKey.type === 'nulldata' && o.scriptPubKey.hex.endsWith(hash))).toBe(true);
    await api().post('/api/regtest/mine').send({ blocks: 2 });
    const v = await api().get(`/api/vaults/${walletId}/documents/${deedId}/versions/2/anchor`).set(as(token));
    expect(v.body).toMatchObject({ valid: true, confirmations: 3, height: tip });
    expect((await api().post(`/api/vaults/${walletId}/documents/${deedId}/versions/2/anchor`).set(as(token)).send({})).status).toBe(409);
    expect((await api().get(`/api/vaults/${walletId}/documents/${deedId}/versions/1/anchor`).set(as(token))).status).toBe(404);
    const list = (await api().get(`/api/vaults/${walletId}/documents`).set(as(token))).body;
    expect(list.find((d: any) => d.id === deedId).latest.anchored).toBe(true);
  });
});

describe('passphrase change re-encrypts everything', () => {
  it('rotates salt, data key and ciphertexts; old passphrase stops working', async () => {
    const before = JSON.parse(readFileSync(vaultFile(walletId), 'utf8'));
    const attBefore = attFiles(walletId).map((f) => readFileSync(f).toString('hex'));
    expect((await api().post(`/api/vaults/${walletId}/passphrase`).set(as(token)).send({ current: 'wrong passphrase!!', next: 'new passphrase 2026' })).status).toBe(401);
    expect((await api().post(`/api/vaults/${walletId}/passphrase`).set(as(token)).send({ current: PASS, next: 'short' })).status).toBe(400);
    const r = await api().post(`/api/vaults/${walletId}/passphrase`).set(as(token)).send({ current: PASS, next: 'new passphrase 2026' });
    expect(r.status).toBe(200);
    const after = JSON.parse(readFileSync(vaultFile(walletId), 'utf8'));
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(after.wrappedKey.ct).not.toBe(before.wrappedKey.ct);
    expect(after.index.ct).not.toBe(before.index.ct);
    const attAfter = attFiles(walletId).map((f) => readFileSync(f).toString('hex'));
    attAfter.forEach((h, i) => expect(h).not.toBe(attBefore[i]));
    // same session keeps working with the rotated key
    expect((await api().get(`/api/vaults/${walletId}/documents/${deedId}/attachments/${attId}`).set(as(token))).status).toBe(200);
    expect((await api().post(`/api/vaults/${walletId}/unlock`).send({ passphrase: PASS })).status).toBe(401);
    token = await unlock(walletId, 'new passphrase 2026');
    const d = (await api().get(`/api/vaults/${walletId}/documents/${deedId}`).set(as(token))).body;
    expect(d.versions[1].content).toContain('Amendment 1');
    expect(d.versions[1].anchor.txid).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('encrypted backup', () => {
  it('exports ciphertext only and restores with the passphrase', async () => {
    const b = await api().get(`/api/vaults/${walletId}/backup`).set(as(token));
    expect(b.status).toBe(200);
    const backup = b.body;
    expect(backup).toMatchObject({ format: 'btctrust-vault-backup', version: 1, walletId });
    expect(JSON.stringify(backup)).not.toContain('SECRET-BENEFICIARY-ALICE');
    expect(Object.keys(backup.attachments)).toHaveLength(2);
    // simulate disaster: wipe the vault index by overwriting with garbage
    writeFileSync(vaultFile(walletId), '{"format":"broken"}');
    expect((await api().post(`/api/vaults/${walletId}/restore`).send({ backup, passphrase: 'new passphrase 2026' })).status).toBe(409);
    expect((await api().post(`/api/vaults/${walletId}/restore`).send({ backup, passphrase: 'wrong passphrase 1', overwrite: true })).status).toBe(401);
    const tampered = JSON.parse(JSON.stringify(backup));
    const k = Object.keys(tampered.attachments)[0];
    const bytes = Buffer.from(tampered.attachments[k], 'base64'); bytes[40] ^= 1; tampered.attachments[k] = bytes.toString('base64');
    expect((await api().post(`/api/vaults/${walletId}/restore`).send({ backup: tampered, passphrase: 'new passphrase 2026', overwrite: true })).status).toBe(422);
    const r = await api().post(`/api/vaults/${walletId}/restore`).send({ backup, passphrase: 'new passphrase 2026', overwrite: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ restored: true, documents: 6, attachments: 2 });
    token = r.body.session;
    const dl = await api().get(`/api/vaults/${walletId}/documents/${deedId}/attachments/${attId}`).set(as(token));
    expect(dl.status).toBe(200);
    expect((await api().get(`/api/vaults/${walletId}/documents/${deedId}`).set(as(token))).body.versions[0].content).toContain('SECRET-BENEFICIARY-ALICE');
    // a backup cannot be restored onto another wallet
    const other = await api().post('/api/wallets').send({ name: 'Other', type: 'singlesig' });
    expect((await api().post(`/api/vaults/${other.body.id}/restore`).send({ backup, passphrase: 'new passphrase 2026' })).status).toBe(400);
  });
});

describe('auto-lock and brute-force throttling', () => {
  it('auto-locks after inactivity', async () => {
    const quick = createApp({ ...cfg, vault: { ...cfg.vault, idleMs: 300 } }, rpc, store, mock);
    const w = await request(quick).post('/api/wallets').send({ name: 'Idle', type: 'singlesig' });
    const t = (await request(quick).post(`/api/vaults/${w.body.id}`).send({ passphrase: PASS })).body.session;
    expect((await request(quick).get(`/api/vaults/${w.body.id}/documents`).set(as(t))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 450));
    const r = await request(quick).get(`/api/vaults/${w.body.id}/documents`).set(as(t));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/auto-locked/);
  });

  it('throttles repeated wrong passphrases', async () => {
    const w = await api().post('/api/wallets').send({ name: 'Brute', type: 'singlesig' });
    await api().post(`/api/vaults/${w.body.id}`).send({ passphrase: PASS });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await api().post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: `nope nope nope ${i}` })).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
    expect((await api().post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: PASS })).status).toBe(429);
  });
});

describe('wallet-signature second factor', () => {
  it('software cosigner: passphrase alone is not enough; a valid signmessage signature unlocks', async () => {
    const w = await api().post('/api/wallets').send({ name: '2FA Trust', type: 'multisig' });
    const c = await api().post(`/api/vaults/${w.body.id}`).send({ passphrase: PASS, secondFactor: { cosigner: 1 } });
    expect(c.status).toBe(201);
    const st = (await api().get(`/api/vaults/${w.body.id}/status`)).body;
    expect(st.secondFactor).toMatchObject({ cosigner: 1, kind: 'software' });
    expect(st.secondFactor.address).toMatch(/^[mn]/); // P2PKH regtest
    await api().post(`/api/vaults/${w.body.id}/lock`).set(as(c.body.session));

    const u = await api().post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: PASS });
    expect(u.body.unlocked).toBe(false);
    expect(u.body.session).toBeUndefined();
    const ch = u.body.challenge;
    expect(ch.message).toContain(ch.id);
    // a signature over a different message, or by another key, is rejected
    const wrongMsg = await rpc.call<string>('signmessage', [ch.address, 'something else'], `btctrust-${w.body.id}-key2`);
    expect((await api().post(`/api/vaults/${w.body.id}/unlock/verify`).send({ challengeId: ch.id, signature: wrongMsg })).status).toBe(401);
    // an external wallet signs the exact challenge (here: bitcoind signmessage, the same format Electrum/Sparrow produce)
    const sig = await rpc.call<string>('signmessage', [ch.address, ch.message], `btctrust-${w.body.id}-key2`);
    const ok = await api().post(`/api/vaults/${w.body.id}/unlock/verify`).send({ challengeId: ch.id, signature: sig });
    expect(ok.status).toBe(200);
    expect(ok.body.session).toMatch(/^[0-9a-f]{64}$/);
    // challenge is single-use
    expect((await api().post(`/api/vaults/${w.body.id}/unlock/verify`).send({ challengeId: ch.id, signature: sig })).status).toBe(401);
    // convenience path: node signs for its own software cosigner
    const u2 = (await api().post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: PASS })).body.challenge;
    const s2 = await api().post(`/api/vaults/${w.body.id}/unlock/sign`).send({ challengeId: u2.id });
    expect(s2.body.signer).toBe('node');
    expect((await api().post(`/api/vaults/${w.body.id}/unlock/verify`).send({ challengeId: u2.id, signature: s2.body.signature })).status).toBe(200);
  });

  it('hardware cosigner signs the challenge on the device (mock adapter)', async () => {
    const devs = (await api().get('/api/devices?refresh=1')).body;
    const w = await api().post('/api/wallets').send({ name: 'HW 2FA', type: 'multisig', hardware: [{ fingerprint: devs[0].fingerprint }] });
    const c = await api().post(`/api/vaults/${w.body.id}`).send({ passphrase: PASS, secondFactor: { cosigner: 0 } });
    expect(c.status).toBe(201);
    const ch = (await api().post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: PASS })).body.challenge;
    expect(ch.kind).toBe('hardware');
    const s = await api().post(`/api/vaults/${w.body.id}/unlock/sign`).send({ challengeId: ch.id });
    expect(s.body.signer).toBe('device');
    expect((await api().post(`/api/vaults/${w.body.id}/unlock/verify`).send({ challengeId: ch.id, signature: s.body.signature })).status).toBe(200);
  });

  it('air-gapped cosigner: user-supplied P2PKH address and pasted signature; can be enabled later', async () => {
    // the "paper" key lives in a separate wallet that stands in for an offline signer
    const src = await api().post('/api/wallets').send({ name: 'paper source', type: 'singlesig' });
    const srcWallet = `btctrust-${src.body.id}`;
    const paperAddr = await rpc.call<string>('getnewaddress', ['', 'legacy'], srcWallet);
    const w = await api().post('/api/wallets').send({ name: 'AG 2FA', type: 'multisig', externalKeys: [src.body.cosigners[0].key] });
    expect(w.body.cosigners[0].kind).toBe('airgapped');
    const t = (await api().post(`/api/vaults/${w.body.id}`).send({ passphrase: PASS })).body.session;
    const sf = (body: object) => api().post(`/api/vaults/${w.body.id}/second-factor`).set(as(t)).send(body);
    expect((await sf({ passphrase: PASS, secondFactor: { cosigner: 0 } })).status).toBe(400); // address required
    const segwit = (await api().post(`/api/wallets/${w.body.id}/address`)).body.address;
    expect((await sf({ passphrase: PASS, secondFactor: { cosigner: 0, address: segwit } })).status).toBe(400);
    expect((await sf({ passphrase: 'wrong passphrase!', secondFactor: { cosigner: 0, address: paperAddr } })).status).toBe(401);
    const r = await sf({ passphrase: PASS, secondFactor: { cosigner: 0, address: paperAddr } });
    expect(r.status).toBe(200);
    expect(r.body.secondFactor).toMatchObject({ cosigner: 0, kind: 'airgapped', address: paperAddr });
    const ch = (await api().post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: PASS })).body.challenge;
    expect((await api().post(`/api/vaults/${w.body.id}/unlock/sign`).send({ challengeId: ch.id })).status).toBe(400); // must be signed offline
    const sig = await rpc.call<string>('signmessage', [paperAddr, ch.message], srcWallet);
    expect((await api().post(`/api/vaults/${w.body.id}/unlock/verify`).send({ challengeId: ch.id, signature: sig })).status).toBe(200);
    const off = await sf({ passphrase: PASS, secondFactor: null });
    expect(off.body.secondFactor).toBeNull();
    expect((await api().post(`/api/vaults/${w.body.id}/unlock`).send({ passphrase: PASS })).body.unlocked).toBe(true);
  });
});
