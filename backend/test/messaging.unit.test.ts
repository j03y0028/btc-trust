import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  TamperError, attestationStatement, authToken, canonical, dmThreadId, newIdentity, openMessage, parseAuthToken, receiptText,
  safetyNumber, sealMessage, signReceipt, verifyDetached, verifyEnvelope, authText, type Nacl,
} from '../../shared/msgcrypto.js';

const N = nacl as unknown as Nacl;
const a = newIdentity(N, 'aaaaaaaa');
const b = newIdentity(N, 'bbbbbbbb');

describe('shared messaging crypto', () => {
  it('canonical JSON is key-order independent', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe(canonical({ a: [{ c: 'x', d: 2 }], b: 1 }));
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it('seals for each recipient with fresh keys; unicode survives', () => {
    const e1 = sealMessage(N, { me: a, walletId: 'w', threadId: 'group', recipients: [a, b], body: { type: 'text', text: 'héllo ₿ 🔐' } });
    const e2 = sealMessage(N, { me: a, walletId: 'w', threadId: 'group', recipients: [a, b], body: { type: 'text', text: 'héllo ₿ 🔐' } });
    expect(e1.ct).not.toBe(e2.ct);
    expect(Object.keys(e1.keys).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(verifyEnvelope(N, e1, a.signPub)).toBe(true);
    expect(verifyEnvelope(N, e1, b.signPub)).toBe(false);
    expect(openMessage(N, e1, b, a.signPub)).toEqual({ type: 'text', text: 'héllo ₿ 🔐' });
    expect(() => openMessage(N, { ...e1, threadId: 'dm:x' }, b, a.signPub)).toThrow(TamperError);
    expect(() => openMessage(N, { ...e1, createdAt: '2020-01-01T00:00:00Z' }, b, a.signPub)).toThrow(TamperError);
  });
  it('sender is always included so they can read their own history', () => {
    const e = sealMessage(N, { me: a, walletId: 'w', threadId: dmThreadId('aaaaaaaa', 'bbbbbbbb'), recipients: [b], body: { type: 'text', text: 'x' } });
    expect(openMessage(N, e, a, a.signPub)).toMatchObject({ text: 'x' });
  });
  it('auth tokens and receipts are Ed25519-signed', () => {
    const t = parseAuthToken(authToken(N, 'w', a, 1790000000000))!;
    expect(t).toMatchObject({ fingerprint: 'aaaaaaaa', ts: 1790000000000 });
    expect(verifyDetached(N, a.signPub, authText('w', 'aaaaaaaa', t.ts), t.sig)).toBe(true);
    expect(verifyDetached(N, a.signPub, authText('w2', 'aaaaaaaa', t.ts), t.sig)).toBe(false);
    const r = signReceipt(N, a, { walletId: 'w', threadId: 'group', upToSeq: 4, at: 'now' });
    expect(verifyDetached(N, a.signPub, receiptText(r), r.sig)).toBe(true);
    expect(verifyDetached(N, a.signPub, receiptText({ ...r, upToSeq: 5 }), r.sig)).toBe(false);
  });
  it('attestation statement and safety number are stable', () => {
    const s = attestationStatement({ walletId: 'w', fingerprint: 'aaaaaaaa', label: 'Jordan', signPub: a.signPub, boxPub: a.boxPub, issuedAt: 'T' });
    expect(s.split('\n')[0]).toBe('BTC Trust trustee attestation v1');
    expect(s).toContain(`ed25519: ${a.signPub}`);
    expect(safetyNumber(N, a)).toBe(safetyNumber(N, { signPub: a.signPub, boxPub: a.boxPub }));
    expect(safetyNumber(N, a)).not.toBe(safetyNumber(N, b));
    expect(dmThreadId('bbbbbbbb', 'aaaaaaaa')).toBe('dm:aaaaaaaa:bbbbbbbb');
  });
});
