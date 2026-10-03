/**
 * BTC Trust trustee messaging: end-to-end encryption envelope (shared by browser client, server and tests).
 *
 * Primitives come from TweetNaCl (audited port of NaCl), injected so this file has no dependencies:
 *   - Ed25519 (nacl.sign) for identity signatures over every envelope, receipt and auth token
 *   - X25519 + XSalsa20-Poly1305 (nacl.box) to wrap a per-message key for each recipient
 *   - XSalsa20-Poly1305 (nacl.secretbox) for the message body
 * The server sees only ciphertext plus routing metadata (thread, sender, recipients, time, urgent flag).
 */

export interface Nacl {
  randomBytes(n: number): Uint8Array;
  box: {
    (msg: Uint8Array, nonce: Uint8Array, theirPub: Uint8Array, mySecret: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, theirPub: Uint8Array, mySecret: Uint8Array): Uint8Array | null;
    keyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
    nonceLength: number;
  };
  secretbox: {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    keyLength: number;
    nonceLength: number;
  };
  sign: {
    keyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
    detached: { (msg: Uint8Array, secretKey: Uint8Array): Uint8Array; verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean };
  };
  hash(msg: Uint8Array): Uint8Array; // SHA-512
}

export const PROTOCOL = 'btctrust-msg-v1';

// ---------- encoding ----------
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);
export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(String(s));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Deterministic JSON (sorted keys, no whitespace) so signatures are reproducible on every side. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export class TamperError extends Error {
  constructor(message: string) { super(message); this.name = 'TamperError'; }
}

// ---------- identities ----------
export interface PublicIdentity { fingerprint: string; signPub: string; boxPub: string }
export interface SecretIdentity extends PublicIdentity { signSecret: string; boxSecret: string; createdAt: string }

export function newIdentity(nacl: Nacl, fingerprint: string): SecretIdentity {
  const s = nacl.sign.keyPair();
  const x = nacl.box.keyPair();
  return { fingerprint, signPub: b64(s.publicKey), signSecret: b64(s.secretKey), boxPub: b64(x.publicKey), boxSecret: b64(x.secretKey), createdAt: new Date().toISOString() };
}

/** Text the cosigner's Bitcoin key signs (signmessage) to bind the messaging keys to that cosigner. */
export function attestationStatement(a: { walletId: string; fingerprint: string; label: string; signPub: string; boxPub: string; issuedAt: string }) {
  return [
    'BTC Trust trustee attestation v1',
    `wallet: ${a.walletId}`,
    `cosigner: ${a.fingerprint} (${a.label})`,
    `ed25519: ${a.signPub}`,
    `x25519: ${a.boxPub}`,
    `issued: ${a.issuedAt}`,
  ].join('\n');
}

/** Short comparable code for out-of-band key verification (like Signal safety numbers). */
export function safetyNumber(nacl: Nacl, id: { signPub: string; boxPub: string }) {
  const h = hex(nacl.hash(utf8(`${PROTOCOL}:safety:${id.signPub}:${id.boxPub}`))).slice(0, 30);
  return h.match(/.{5}/g)!.map((x) => String(parseInt(x, 16) % 100000).padStart(5, '0')).join(' ');
}

export function signDetached(nacl: Nacl, me: Pick<SecretIdentity, 'signSecret'>, text: string) {
  return b64(nacl.sign.detached(utf8(text), unb64(me.signSecret)));
}
export function verifyDetached(nacl: Nacl, signPub: string, text: string, sig: string) {
  try { return nacl.sign.detached.verify(utf8(text), unb64(sig), unb64(signPub)); } catch { return false; }
}

// ---------- auth tokens (HTTP header / WebSocket hello) ----------
export const authText = (walletId: string, fingerprint: string, ts: number) => `${PROTOCOL}:auth:${walletId}:${fingerprint}:${ts}`;
export function authToken(nacl: Nacl, walletId: string, me: SecretIdentity, ts = Date.now()) {
  return `${me.fingerprint}.${ts}.${signDetached(nacl, me, authText(walletId, me.fingerprint, ts))}`;
}
export function parseAuthToken(token: string) {
  const m = String(token ?? '').match(/^([0-9a-f]{8})\.(\d{10,})\.([A-Za-z0-9+/=]+)$/);
  return m ? { fingerprint: m[1], ts: Number(m[2]), sig: m[3] } : null;
}

// ---------- message envelopes ----------
export type Body =
  | { type: 'text'; text: string }
  | { type: 'sigreq'; requestId: string; text?: string; txid: string; summary: string }
  | { type: 'sigreq-update'; requestId: string; action: 'signed' | 'broadcast' | 'declined'; text?: string; signatures?: number; required?: number; txid?: string }
  | { type: 'attachment'; text?: string; vault: { docId: string; attId: string; name: string; mime: string; sha256: string } };

export interface Envelope {
  protocol: typeof PROTOCOL;
  id: string;
  walletId: string;
  threadId: string;
  sender: string;        // cosigner fingerprint
  senderKey: string;     // sender's Ed25519 public key (pins the identity version)
  senderBox: string;     // sender's X25519 public key used for wrapping
  createdAt: string;
  urgent: boolean;
  nonce: string;         // secretbox nonce
  ct: string;            // secretbox(body)
  keys: Record<string, { pub: string; nonce: string; box: string }>; // per-recipient wrapped message key
  sig: string;           // Ed25519 over canonical(envelope without sig)
}

export const envelopeText = (e: Omit<Envelope, 'sig'> | Envelope) => {
  const { sig: _sig, ...rest } = e as Envelope;
  void _sig;
  return `${PROTOCOL}:envelope:${canonical(rest)}`;
};

export const dmThreadId = (a: string, b: string) => `dm:${[a, b].sort().join(':')}`;

export function sealMessage(nacl: Nacl, p: {
  me: SecretIdentity; walletId: string; threadId: string; recipients: PublicIdentity[]; body: Body; urgent?: boolean; id?: string; createdAt?: string;
}): Envelope {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const keys: Envelope['keys'] = {};
  const all = p.recipients.some((r) => r.fingerprint === p.me.fingerprint) ? p.recipients : [...p.recipients, p.me];
  for (const r of all) {
    const n = nacl.randomBytes(nacl.box.nonceLength);
    keys[r.fingerprint] = { pub: r.boxPub, nonce: b64(n), box: b64(nacl.box(key, n, unb64(r.boxPub), unb64(p.me.boxSecret))) };
  }
  const env: Omit<Envelope, 'sig'> = {
    protocol: PROTOCOL, id: p.id ?? hex(nacl.randomBytes(16)), walletId: p.walletId, threadId: p.threadId,
    sender: p.me.fingerprint, senderKey: p.me.signPub, senderBox: p.me.boxPub, createdAt: p.createdAt ?? new Date().toISOString(),
    urgent: !!p.urgent, nonce: b64(nonce), ct: b64(nacl.secretbox(utf8(JSON.stringify(p.body)), nonce, key)), keys,
  };
  key.fill(0);
  return { ...env, sig: signDetached(nacl, p.me, envelopeText(env)) };
}

export function verifyEnvelope(nacl: Nacl, env: Envelope, expectedSignPub?: string) {
  if (!env || env.protocol !== PROTOCOL) return false;
  if (expectedSignPub && env.senderKey !== expectedSignPub) return false;
  return verifyDetached(nacl, env.senderKey, envelopeText(env), env.sig);
}

/** Verify the sender signature, unwrap our key and decrypt. Throws TamperError on any mismatch. */
export function openMessage(nacl: Nacl, env: Envelope, me: SecretIdentity, senderSignPub: string): Body {
  if (!verifyEnvelope(nacl, env, senderSignPub)) throw new TamperError('Signature check failed: message was altered or not sent by this trustee');
  const k = env.keys[me.fingerprint];
  if (!k) throw new TamperError('This message was not encrypted for you');
  const key = nacl.box.open(unb64(k.box), unb64(k.nonce), unb64(env.senderBox), unb64(me.boxSecret));
  if (!key) throw new TamperError('Could not unwrap message key (wrong identity key or altered)');
  const pt = nacl.secretbox.open(unb64(env.ct), unb64(env.nonce), key);
  key.fill(0);
  if (!pt) throw new TamperError('Ciphertext failed authentication');
  return JSON.parse(fromUtf8(pt)) as Body;
}

// ---------- read receipts ----------
export interface Receipt { walletId: string; threadId: string; fingerprint: string; upToSeq: number; at: string; sig: string }
export const receiptText = (r: Omit<Receipt, 'sig'>) => `${PROTOCOL}:read:${canonical({ walletId: r.walletId, threadId: r.threadId, fingerprint: r.fingerprint, upToSeq: r.upToSeq, at: r.at })}`;
export function signReceipt(nacl: Nacl, me: SecretIdentity, r: Omit<Receipt, 'sig' | 'fingerprint'>): Receipt {
  const x = { ...r, fingerprint: me.fingerprint };
  return { ...x, sig: signDetached(nacl, me, receiptText(x)) };
}
