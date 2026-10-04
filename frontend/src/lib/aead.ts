/**
 * AES-256-GCM for the browser keyring, with or without WebCrypto.
 *
 * Browsers only expose crypto.subtle in "secure contexts" (https:// or http://localhost). Opening the app as
 * http://192.168.x.x or http://mynode.local hides it, so WebCrypto calls crash. Here WebCrypto is used when it
 * exists; otherwise the audited pure-JS AES-GCM from @noble/ciphers. Both produce identical bytes
 * (ciphertext || 16-byte tag, 12-byte IV, same AAD), so a keyring sealed one way opens the other way.
 * crypto.getRandomValues is available in insecure contexts too, and is the only randomness source used.
 */
import { gcm } from '@noble/ciphers/aes.js'

export type CryptoBackend = 'webcrypto' | 'js'

/** A friendly, user-facing error when the browser cannot do the cryptography at all. */
export class CryptoUnavailable extends Error {
  constructor(detail: string) {
    super(`This browser could not run the encryption needed for trustee keys (${detail}). Try an up-to-date Safari, Chrome or Firefox, or open the app over HTTPS.`)
    this.name = 'CryptoUnavailable'
  }
}

export const hasWebCrypto = () => {
  try { return typeof globalThis.crypto?.subtle?.importKey === 'function' } catch { return false }
}
export const cryptoBackend = (): CryptoBackend => (hasWebCrypto() ? 'webcrypto' : 'js')

export function randomBytes(n: number): Uint8Array {
  const c = globalThis.crypto
  if (typeof c?.getRandomValues !== 'function') throw new CryptoUnavailable('no secure random number generator')
  return c.getRandomValues(new Uint8Array(n))
}

export interface AesKey {
  readonly backend: CryptoBackend
  seal(iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  /** Throws on a wrong key / tampered data (GCM tag mismatch). */
  open(iv: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  /** Forget the key material (pure-JS keys are zeroed; WebCrypto keys are non-extractable and dropped). */
  destroy(): void
}

function jsKey(raw: Uint8Array): AesKey {
  let k: Uint8Array | null = raw.slice()
  const use = () => { if (!k) throw new Error('Key was locked'); return k }
  return {
    backend: 'js',
    seal: async (iv, pt, aad) => gcm(use(), iv, aad).encrypt(pt),
    open: async (iv, ct, aad) => gcm(use(), iv, aad).decrypt(ct),
    destroy: () => { k?.fill(0); k = null },
  }
}

async function webKey(raw: Uint8Array): Promise<AesKey> {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  let live: CryptoKey | null = key
  const use = () => { if (!live) throw new Error('Key was locked'); return live }
  return {
    backend: 'webcrypto',
    seal: async (iv, pt, aad) => new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource }, use(), pt as BufferSource)),
    open: async (iv, ct, aad) => new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource }, use(), ct as BufferSource)),
    destroy: () => { live = null },
  }
}

/** Import a 32-byte AES key. Uses WebCrypto when present (falls back to pure JS if it refuses), unless forced. */
export async function importAesKey(raw: Uint8Array, force?: CryptoBackend): Promise<AesKey> {
  if (raw.length !== 32) throw new Error('AES-256 key must be 32 bytes')
  const want = force ?? cryptoBackend()
  if (want === 'webcrypto') {
    if (force === 'webcrypto' && !hasWebCrypto()) throw new CryptoUnavailable('WebCrypto is not available here')
    try { return await webKey(raw) } catch (e) { if (force) throw e }
  }
  try { return jsKey(raw) } catch (e) { throw new CryptoUnavailable((e as Error).message) }
}
