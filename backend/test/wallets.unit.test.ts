import { describe, it, expect } from 'vitest';
import { parseDescriptor, validateMN, changeVariant, summarizePsbt, assertNoPrivateKeys, MAX_KEYS } from '../src/wallets.js';

const TPUB = 'tpubDCaQ77ij4oNpPRrPEbp6BAhuvU3fQ9S584zD33cqhkBWGPf5w1YJk4EpBcqfhhk3vNX9YwSX1J3eVMqagm4A6kRyFGaVio2jn44g1iatq3M';

describe('validateMN', () => {
  it('accepts 1<=m<=n<=15', () => {
    expect(() => validateMN(2, 3)).not.toThrow();
    expect(() => validateMN(1, 1)).not.toThrow();
    expect(() => validateMN(15, 15)).not.toThrow();
  });
  it('rejects bad combinations', () => {
    for (const [m, n] of [[0, 3], [4, 3], [2, MAX_KEYS + 1], [1.5, 3]]) expect(() => validateMN(m, n)).toThrow(/Invalid multisig/);
  });
});

describe('descriptors', () => {
  it('parses m, n and key fingerprints from sortedmulti', () => {
    const d = `wsh(sortedmulti(2,[aabbccdd/84h/1h/0h]${TPUB}/0/*,[11223344/84h/1h/0h]${TPUB}/0/*,${TPUB}/0/*))#abcdefgh`;
    const p = parseDescriptor(d);
    expect(p.m).toBe(2);
    expect(p.n).toBe(3);
    expect(p.keys.map((k) => k.fingerprint)).toEqual(['aabbccdd', '11223344', '']);
  });
  it('treats single-key descriptors as 1-of-1', () => {
    expect(parseDescriptor(`wpkh(${TPUB}/0/*)`)).toMatchObject({ m: 1, n: 1 });
  });
  it('derives a change descriptor and strips the checksum', () => {
    expect(changeVariant(`wpkh(${TPUB}/0/*)#12345678`)).toBe(`wpkh(${TPUB}/1/*)`);
    expect(changeVariant(`wpkh(${TPUB}/5)`)).toBeUndefined();
  });
});

describe('private key guard', () => {
  it('rejects tprv/xprv and WIF keys', () => {
    expect(() => assertNoPrivateKeys(`wpkh(tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK/0/*)`)).toThrow(/Private keys/);
    expect(() => assertNoPrivateKeys('cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy')).toThrow(/Private keys/);
    expect(() => assertNoPrivateKeys(`wpkh(${TPUB}/0/*)`)).not.toThrow();
  });
});

describe('summarizePsbt', () => {
  const tx = { txid: 'ff'.repeat(32), vout: [{ value: 1, scriptPubKey: { address: 'bcrt1qdest' } }, { value: 0.5, scriptPubKey: { address: 'bcrt1qchange' } }] };
  const derivs = [{ pubkey: 'p1', master_fingerprint: 'aaaa0001' }, { pubkey: 'p2', master_fingerprint: 'aaaa0002' }, { pubkey: 'p3', master_fingerprint: 'aaaa0003' }];
  const outputs = [{}, { bip32_derivs: [{}] }];
  it('counts the minimum signatures across inputs and who signed', () => {
    const s = summarizePsbt('x', { tx, outputs, fee: 0.0001, inputs: [
      { partial_signatures: { p1: 's', p2: 's' }, bip32_derivs: derivs },
      { partial_signatures: { p1: 's' }, bip32_derivs: derivs },
    ] }, 2);
    expect(s.signatures).toBe(1);
    expect(s.signedBy).toEqual(['aaaa0001']);
    expect(s.complete).toBe(false);
    expect(s.outputs[1].isChange).toBe(true);
    expect(s.outputs[0].isChange).toBe(false);
  });
  it('is complete once every input has m signatures or is finalized', () => {
    const s = summarizePsbt('x', { tx, outputs, inputs: [
      { partial_signatures: { p1: 's', p3: 's' }, bip32_derivs: derivs },
      { final_scriptwitness: ['00'] },
    ] }, 2);
    expect(s.signatures).toBe(2);
    expect(s.complete).toBe(true);
  });
});
