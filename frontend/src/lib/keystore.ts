/**
 * Encrypted-at-rest storage for trustee secret keys (Ed25519 + X25519) in the browser.
 *  - KDF: scrypt (N=2^17, r=8, p=1) from @noble/hashes (audited), random 16-byte salt.
 *  - Cipher: AES-256-GCM via WebCrypto, random 12-byte IV per write, AAD binds the format version.
 * Secrets live decrypted only in memory while unlocked; the store auto-locks after inactivity.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { base64 } from '@scure/base'

export const LEGACY_KEY = 'btctrust-trustee-keys-v1'
export const STORE_KEY = 'btctrust-trustee-keys-v2'
const AAD = new TextEncoder().encode('btctrust-keyring-v2')
export const MIN_PASSPHRASE = 10
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const

export interface EncryptedRing {
  v: 2; kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }; cipher: 'AES-256-GCM'; iv: string; ct: string; createdAt: string; changedAt: string
}
export type KeyState = 'empty' | 'legacy' | 'locked' | 'unlocked'
export class WrongPassphrase extends Error { constructor() { super('Wrong passphrase'); this.name = 'WrongPassphrase' } }

type Json = Record<string, unknown>
const subtle = () => globalThis.crypto.subtle
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n))

async function deriveKey(passphrase: string, kdf: EncryptedRing['kdf']): Promise<CryptoKey> {
  const raw = await scryptAsync(passphrase.normalize('NFKC'), base64.decode(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 30 })
  const key = await subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  raw.fill(0)
  return key
}
async function seal(key: CryptoKey, data: Json, kdf: EncryptedRing['kdf'], createdAt?: string): Promise<EncryptedRing> {
  const iv = rand(12)
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: AAD as BufferSource }, key, new TextEncoder().encode(JSON.stringify(data)) as BufferSource))
  const now = new Date().toISOString()
  return { v: 2, kdf, cipher: 'AES-256-GCM', iv: base64.encode(iv), ct: base64.encode(ct), createdAt: createdAt ?? now, changedAt: now }
}
async function open(key: CryptoKey, blob: EncryptedRing): Promise<Json> {
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: base64.decode(blob.iv) as BufferSource, additionalData: AAD as BufferSource }, key, base64.decode(blob.ct) as BufferSource)
    return JSON.parse(new TextDecoder().decode(pt))
  } catch { throw new WrongPassphrase() }
}

export class KeyStore {
  private data: Json | null = null
  private key: CryptoKey | null = null
  private blob: EncryptedRing | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  private writing: Promise<void> = Promise.resolve()
  private version = 0
  opts: { N?: number; idleMs?: number; storage?: Storage }
  constructor(opts: { N?: number; idleMs?: number; storage?: Storage } = {}) { this.opts = opts }

  private get storage() { return this.opts.storage ?? localStorage }
  private readBlob(): EncryptedRing | null { try { const b = JSON.parse(this.storage.getItem(STORE_KEY) ?? 'null'); return b?.v === 2 ? b : null } catch { return null } }
  private emit() { this.version++; for (const l of this.listeners) l() }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  getVersion = () => this.version

  state(): KeyState {
    if (this.data) return 'unlocked'
    if (this.readBlob()) return 'locked'
    if (this.storage.getItem(LEGACY_KEY)) return 'legacy'
    return 'empty'
  }
  /** Decrypted ring, or null when locked. */
  get ring(): Json | null { return this.data }
  kdfInfo() { const b = this.readBlob(); return b ? { ...b.kdf, salt: undefined, cipher: b.cipher, changedAt: b.changedAt } : null }

  private newKdf(): EncryptedRing['kdf'] { return { name: 'scrypt', N: this.opts.N ?? DEFAULT_KDF.N, r: DEFAULT_KDF.r, p: DEFAULT_KDF.p, salt: base64.encode(rand(16)) } }
  private check(pass: string) { if (pass.length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`) }
  private armIdle() {
    if (this.timer) clearTimeout(this.timer)
    const ms = this.opts.idleMs ?? 5 * 60_000
    if (ms > 0 && this.data) this.timer = setTimeout(() => this.lock(), ms)
  }
  /** Reset the auto-lock timer (call on user activity). */
  touch() { if (this.data) this.armIdle() }

  /** First use on this device: create an empty encrypted ring. */
  async create(pass: string) {
    if (this.state() !== 'empty') throw new Error('A keyring already exists on this device')
    this.check(pass)
    const kdf = this.newKdf()
    this.key = await deriveKey(pass, kdf)
    this.data = {}
    this.blob = await seal(this.key, this.data, kdf)
    this.storage.setItem(STORE_KEY, JSON.stringify(this.blob))
    this.armIdle(); this.emit()
  }
  /** Encrypt existing plaintext (v1) keys, verify the ciphertext decrypts back identically, then delete the plaintext. */
  async migrate(pass: string) {
    if (this.state() !== 'legacy') throw new Error('Nothing to migrate')
    this.check(pass)
    const legacy = JSON.parse(this.storage.getItem(LEGACY_KEY)!) as Json
    const kdf = this.newKdf()
    const key = await deriveKey(pass, kdf)
    const blob = await seal(key, legacy, kdf)
    if (JSON.stringify(await open(key, blob)) !== JSON.stringify(legacy)) throw new Error('Migration self-check failed; plaintext kept')
    this.storage.setItem(STORE_KEY, JSON.stringify(blob))
    this.storage.removeItem(LEGACY_KEY)
    this.key = key; this.blob = blob; this.data = legacy
    this.armIdle(); this.emit()
  }
  async unlock(pass: string) {
    const blob = this.readBlob()
    if (!blob) throw new Error('No encrypted keyring on this device')
    const key = await deriveKey(pass, blob.kdf)
    this.data = await open(key, blob)
    this.key = key; this.blob = blob
    this.armIdle(); this.emit()
  }
  lock() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.data = null; this.key = null; this.blob = null
    this.emit()
  }
  /** Re-encrypt under a new passphrase with a fresh salt; the current passphrase must be correct. */
  async changePassphrase(current: string, next: string) {
    this.check(next)
    const blob = this.readBlob()
    if (!blob) throw new Error('No encrypted keyring on this device')
    const data = await open(await deriveKey(current, blob.kdf), blob)
    await this.writing
    const kdf = this.newKdf()
    const key = await deriveKey(next, kdf)
    this.blob = await seal(key, data, kdf, blob.createdAt)
    this.storage.setItem(STORE_KEY, JSON.stringify(this.blob))
    this.key = key; this.data = data
    this.armIdle(); this.emit()
  }
  /** Replace the decrypted ring and persist it encrypted (new IV). Throws while locked. */
  update(mutate: (ring: Json) => void): Promise<void> {
    if (!this.data || !this.key || !this.blob) throw new Error('Trustee keys are locked: unlock them first')
    mutate(this.data)
    const key = this.key, kdf = this.blob.kdf, created = this.blob.createdAt, snapshot = structuredClone(this.data)
    this.writing = this.writing.then(async () => {
      this.blob = await seal(key, snapshot, kdf, created)
      this.storage.setItem(STORE_KEY, JSON.stringify(this.blob))
    })
    this.touch(); this.emit()
    return this.writing
  }
  flush() { return this.writing }
}

export const keyStore = new KeyStore()
