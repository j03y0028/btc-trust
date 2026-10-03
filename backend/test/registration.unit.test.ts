import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fx from './fixtures/wallets-public.json' with { type: 'json' };
import vectors from './fixtures/ledger-policies.json' with { type: 'json' };
import type { WalletConfig } from '../src/store.js';
import { coldcardMultisigFile, coldcardToDescriptor, parseColdcardMultisig, coldcardName } from '../src/registration/coldcard.js';
import { MockLedger, policyId, serializePolicy, walletPolicyFor } from '../src/registration/ledger.js';
import { inspectXpub, parseKeyOrigin } from '../src/registration/keys.js';
import { RegistrationService } from '../src/registration/service.js';

const W = fx.wallets as unknown as Record<string, WalletConfig>;
const trezorVault = W['trezor-trust-vault-ed1bf5'];
const board = W['board-reserve-c49ef7'];
const noChecksum = (d: string) => d.replace(/#[0-9a-z]{8}$/, '');

describe('Coldcard multisig setup file', () => {
  it('generates the simple-text format with per-key Derivation groups', () => {
    const t = coldcardMultisigFile(trezorVault, new Date('2026-10-02T12:00:00Z'));
    expect(t).toContain('Name: Trezor Trust Vault\nPolicy: 2 of 3\nFormat: P2WSH\n');
    expect(t).toMatch(/Derivation: m\/48h\/1h\/0h\/2h\n5C9E228D: tpub[1-9A-HJ-NP-Za-km-z]+\n\nDerivation: m\/84h\/1h\/0h\nD2130B22: tpub\w+\n556F0ACC: tpub\w+\n$/);
    expect(t.split('\n').filter((l) => l && !l.startsWith('#') && !l.includes(':'))).toEqual([]);
  });
  it('round-trips through the firmware-rule parser back to the exact wallet descriptor', () => {
    for (const w of [trezorVault, board]) {
      const c = parseColdcardMultisig(coldcardMultisigFile(w));
      expect(c).toMatchObject({ m: w.m, n: w.n, format: 'P2WSH' });
      expect(coldcardToDescriptor(c)).toBe(noChecksum(w.descriptors.receive));
    }
  });
  it('enforces Coldcard limits: 20-char ASCII name', () => {
    expect(coldcardName('The Whitfield Family Irrevocable Trust ✨')).toBe('The Whitfield Family Irre');
    const t = coldcardMultisigFile({ ...board, name: 'The Whitfield Family Irrevocable Trust' });
    expect(parseColdcardMultisig(t).name).toBe('The Whitfield Family Irre');
  });
  it('rejects malformed files like the device would', () => {
    const good = coldcardMultisigFile(trezorVault);
    const bad = (from: string | RegExp, to: string) => () => parseColdcardMultisig(good.replace(from, to));
    expect(bad('Policy: 2 of 3', 'Policy: 2 of 4')).toThrow(/4 keys but file has 3/);
    expect(bad('Policy: 2 of 3', 'Policy: 4 of 3')).toThrow(/bad policy/);
    expect(bad('Format: P2WSH', 'Format: P2TR')).toThrow(/unknown format/);
    expect(bad(/tpubDEGq\w{4}/, 'tpubDEGqXXXX')).toThrow(/checksum/);
    expect(bad('D2130B22', '5C9E228D')).toThrow(/duplicate XFP/);
    expect(bad('Derivation: m/48h/1h/0h/2h', '')).toThrow(/before any Derivation/);
    expect(bad('Name: Trezor Trust Vault', 'Name: ' + 'x'.repeat(21))).toThrow(/name/);
    expect(bad('Name: Trezor Trust Vault', 'Wallet Trezor')).toThrow(/label: value/);
  });
  it('refuses wallets a Coldcard cannot represent', () => {
    expect(() => coldcardMultisigFile({ ...trezorVault, descriptors: { receive: trezorVault.descriptors.receive.replace('sortedmulti', 'multi') } })).toThrow(/sortedmulti/);
    expect(() => coldcardMultisigFile({ ...trezorVault, type: 'singlesig' })).toThrow(/multisig/);
    // xpub depth must match its derivation path
    const k = parseKeyOrigin(board.cosigners[0].key);
    expect(inspectXpub(k.xpub)).toMatchObject({ network: 'test', depth: 3 });
    const wrongDepth = board.descriptors.receive.replace(`[${k.fingerprint}/84h/1h/0h]`, `[${k.fingerprint}/84h/1h]`);
    expect(() => coldcardMultisigFile({ ...board, descriptors: { receive: wrongDepth } })).toThrow(/depth 3/);
  });
});

describe('Ledger wallet policy (BIP-388)', () => {
  it('policy id and serialization match the official ledger_bitcoin 0.4.2 library', () => {
    for (const v of vectors) {
      const p = walletPolicyFor({ ...W[v.walletId], name: v.name });
      expect(p).toEqual({ name: v.name, template: v.template, keys: v.keys });
      expect(serializePolicy(p).toString('hex')).toBe(v.serialized);
      expect(policyId(p)).toBe(v.id);
    }
  });
  it('mock device registers only policies containing its key and returns a verifiable HMAC', async () => {
    const p = walletPolicyFor(trezorVault);
    const dev = new MockLedger('d2130b22');
    const r = await dev.registerWallet(p);
    expect(r.policyId).toBe(policyId(p));
    expect(r.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(dev.verifyHmac(p, r.hmac)).toBe(true);
    expect(dev.verifyHmac({ ...p, template: p.template.replace('2,', '1,') }, r.hmac)).toBe(false);
    expect(new MockLedger('d2130b22', 'other seed').verifyHmac(p, r.hmac)).toBe(false);
    await expect(new MockLedger('deadbeef').registerWallet(p)).rejects.toThrow(/none of the policy keys/);
  });
});

describe('registration service', () => {
  const fakeWallets = { get: (id: string) => W[id] } as never;
  const noDevices = { available: false, list: async () => [] } as never;
  it('Trezor cosigners need no registration; Ledger HMAC is stored and re-verified; Coldcard import recorded', async () => {
    const svc = new RegistrationService(fakeWallets, noDevices, { dataDir: mkdtempSync(join(tmpdir(), 'btctrust-reg-')), network: 'regtest' });
    const st = await svc.status('trezor-trust-vault-ed1bf5');
    expect(st.cosigners[0].trezor?.required).toBe(false);
    expect(st.cosigners[1].trezor).toBeNull();
    expect(st.hwi.register).toBe(false);
    await expect(svc.registerLedger('trezor-trust-vault-ed1bf5', 0)).rejects.toThrow(/Trezor/);
    const r = await svc.registerLedger('trezor-trust-vault-ed1bf5', 1);
    expect(r).toMatchObject({ device: 'ledger', mock: true, policyId: vectors[0].id });
    expect(svc.verifyLedger('trezor-trust-vault-ed1bf5', 1)).toMatchObject({ sameId: true, hmacValid: true });
    const cc = svc.confirmColdcard('trezor-trust-vault-ed1bf5', 2);
    expect(cc.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    const after = await svc.status('trezor-trust-vault-ed1bf5');
    expect(after.cosigners[1].registrations[0]).toMatchObject({ device: 'ledger', valid: true });
    expect(after.cosigners[2].registrations[0]).toMatchObject({ device: 'coldcard', name: 'Trezor Trust Vault' });
  });
});
