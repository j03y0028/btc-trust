/**
 * Vault cryptography: only Node's built-in OpenSSL primitives (no homemade crypto).
 * - KDF: scrypt (RFC 7914), default N=2^17, r=8, p=1 (OWASP minimum), 32-byte key, 16-byte random salt.
 * - AEAD: AES-256-GCM, 96-bit random IV per encryption, 128-bit tag, associated data binds context (wallet id, record type).
 * - Envelope: the passphrase-derived KEK only wraps a random 256-bit data key (DEK); the DEK encrypts the index and attachments.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface KdfParams { name: 'scrypt'; N: number; r: number; p: number; salt: string; keyLen: 32 }
export interface Box { iv: string; ct: string; tag: string }

export class IntegrityError extends Error {
  constructor(message = 'Integrity check failed: data was tampered with or the key is wrong') {
    super(message);
    this.name = 'IntegrityError';
  }
}

export const DEFAULT_SCRYPT_N = 2 ** 17;

export function newKdfParams(N = DEFAULT_SCRYPT_N): KdfParams {
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 20) throw new Error('scrypt N must be a power of two between 2^14 and 2^20');
  return { name: 'scrypt', N, r: 8, p: 1, salt: randomBytes(16).toString('base64'), keyLen: 32 };
}

export function deriveKey(passphrase: string, k: KdfParams): Promise<Buffer> {
  if (k.name !== 'scrypt') throw new Error(`Unsupported KDF ${k.name}`);
  const pass = Buffer.from(passphrase.normalize('NFKC'), 'utf8');
  return new Promise((resolve, reject) =>
    scrypt(pass, Buffer.from(k.salt, 'base64'), k.keyLen, { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r + 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export const newDataKey = () => randomBytes(32);

export function seal(key: Buffer, plaintext: Buffer, aad: string): Box {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function open(key: Buffer, box: Box, aad: string): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
  } catch {
    throw new IntegrityError();
  }
}

/** Binary framing for attachments: iv(12) | tag(16) | ciphertext. */
export function sealBytes(key: Buffer, data: Buffer, aad: string): Buffer {
  const b = seal(key, data, aad);
  return Buffer.concat([Buffer.from(b.iv, 'base64'), Buffer.from(b.tag, 'base64'), Buffer.from(b.ct, 'base64')]);
}
export function openBytes(key: Buffer, framed: Buffer, aad: string): Buffer {
  if (framed.length < 28) throw new IntegrityError();
  return open(key, { iv: framed.subarray(0, 12).toString('base64'), tag: framed.subarray(12, 28).toString('base64'), ct: framed.subarray(28).toString('base64') }, aad);
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
