import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DEFAULT_SCRYPT_N, IntegrityError, deriveKey, newKdfParams, open, openBytes, seal, sealBytes, sha256 } from '../src/vault/crypto.js';
import { DISCLAIMER, buildTemplate } from '../src/vault/templates.js';

describe('vault crypto (scrypt + AES-256-GCM)', () => {
  it('uses OWASP-strength scrypt defaults', () => {
    const k = newKdfParams();
    expect(k).toMatchObject({ name: 'scrypt', N: DEFAULT_SCRYPT_N, r: 8, p: 1, keyLen: 32 });
    expect(DEFAULT_SCRYPT_N).toBe(2 ** 17);
    expect(Buffer.from(k.salt, 'base64')).toHaveLength(16);
    expect(() => newKdfParams(1000)).toThrow();
  });

  it('derives deterministic keys per salt and normalizes unicode (NFKC)', async () => {
    const k = newKdfParams(2 ** 14);
    const a = await deriveKey('correct horse battery', k);
    expect(a).toHaveLength(32);
    expect((await deriveKey('correct horse battery', k)).equals(a)).toBe(true);
    expect((await deriveKey('correct horse battery', newKdfParams(2 ** 14))).equals(a)).toBe(false);
    expect((await deriveKey('ｃａｆｅ passphrase', k)).equals(await deriveKey('cafe passphrase', k))).toBe(true);
  });

  it('production-cost derivation works (N=2^17)', async () => {
    const t = Date.now();
    expect(await deriveKey('a long passphrase', newKdfParams())).toHaveLength(32);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('round-trips and detects wrong key, tampered ciphertext/tag and wrong context', () => {
    const key = randomBytes(32);
    const box = seal(key, Buffer.from('trust deed'), 'ctx');
    expect(open(key, box, 'ctx').toString()).toBe('trust deed');
    expect(seal(key, Buffer.from('trust deed'), 'ctx').iv).not.toBe(box.iv); // fresh IV
    expect(() => open(randomBytes(32), box, 'ctx')).toThrow(IntegrityError);
    expect(() => open(key, box, 'other-ctx')).toThrow(IntegrityError);
    const ct = Buffer.from(box.ct, 'base64'); ct[0] ^= 1;
    expect(() => open(key, { ...box, ct: ct.toString('base64') }, 'ctx')).toThrow(IntegrityError);
    const tag = Buffer.from(box.tag, 'base64'); tag[15] ^= 1;
    expect(() => open(key, { ...box, tag: tag.toString('base64') }, 'ctx')).toThrow(IntegrityError);
    const framed = sealBytes(key, Buffer.from('%PDF-1.7'), 'att');
    expect(openBytes(key, framed, 'att').toString()).toBe('%PDF-1.7');
    framed[framed.length - 1] ^= 1;
    expect(() => openBytes(key, framed, 'att')).toThrow(IntegrityError);
  });

  it('sha256 matches a known vector', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('trust templates', () => {
  const w = {
    id: 'x', name: 'Whitfield Family Trust', type: 'multisig', network: 'regtest', m: 2, n: 3,
    descriptors: { receive: 'wsh(sortedmulti(2,[aaaaaaaa/48h/1h/0h/2h]tpubA/0/*,[bbbbbbbb/84h/1h/0h]tpubB/0/*,[cccccccc/84h/1h/0h]tpubC/0/*))#abcd1234', change: 'wsh(…/1/*)' },
    cosigners: [
      { label: "Jordan's Trezor", fingerprint: 'aaaaaaaa', key: '[aaaaaaaa/48h/1h/0h/2h]tpubA/0/*', kind: 'hardware' },
      { label: 'Trustee', fingerprint: 'bbbbbbbb', key: '[bbbbbbbb/84h/1h/0h]tpubB/0/*', kind: 'software' },
      { label: 'Paper', fingerprint: 'cccccccc', key: '[cccccccc/84h/1h/0h]tpubC/0/*', kind: 'airgapped' },
    ],
  };
  it('deed fills in quorum and fingerprints, with the legal disclaimer', () => {
    const t = buildTemplate('deed', w);
    expect(t.content).toContain(DISCLAIMER);
    expect(t.content).toMatch(/NOT legal/);
    expect(t.content).toContain('2-of-3 multisignature');
    for (const fp of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) expect(t.content).toContain(fp);
  });
  it('descriptor backup contains the descriptors and is marked public-only', () => {
    const t = buildTemplate('descriptor-backup', w);
    expect(t.content).toContain(w.descriptors.receive);
    expect(t.content).toMatch(/PUBLIC DATA ONLY/);
    expect(t.content).not.toMatch(/[tx]prv/);
  });
  it('trustees schedule maps each cosigner', () => {
    const rows = JSON.parse(buildTemplate('trustees', w).content);
    expect(rows.map((r: any) => r.cosignerFingerprint)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    expect(rows[0]).toMatchObject({ name: "Jordan's Trezor", role: 'Primary trustee', keyType: 'hardware' });
    expect(buildTemplate('succession', w).content).toMatch(/2 of 3/);
  });
});
