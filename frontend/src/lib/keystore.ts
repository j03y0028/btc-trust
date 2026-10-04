/**
 * Encrypted-at-rest storage for trustee secret keys (Ed25519 + X25519) in the browser.
 *  - KDF: scrypt (N=2^17, r=8, p=1) from @noble/hashes (audited), random 16-byte salt.
 *  - Cipher: AES-256-GCM, random 12-byte IV per write, AAD binds the format version. WebCrypto when the page is a
 *    secure context; the audited pure-JS @noble/ciphers otherwise (plain-HTTP LAN access such as http://192.168.1.x
 *    hides crypto.subtle). Same bytes either way, so keyrings open in both.
 * Secrets live decrypted only in memory while unlocked; the store auto-locks after inactivity.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { base64 } from '@scure/base'
import { CryptoUnavailable, importAesKey, randomBytes, type AesKey, type CryptoBackend } from './aead'

export { CryptoUnavailable }
/** Progress of the scrypt key derivation, 0..1. */
export type OnProgress = (fraction: number) => void

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
const rand = randomBytes

async function deriveKey(passphrase: string, kdf: EncryptedRing['kdf'], backend?: CryptoBackend, onProgress?: OnProgress): Promise<AesKey> {
  if (kdf.name !== 'scrypt') throw new Error(`Unsupported key derivation: ${kdf.name}`)
  let raw: Uint8Array
  try {
    raw = await scryptAsync(passphrase.normalize('NFKC'), base64.decode(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 30, asyncTick: 25, ...(onProgress ? { onProgress } : {}) })
  } catch (e) {
    throw new CryptoUnavailable(`key derivation failed: ${(e as Error).message}`)
  }
  try { return await importAesKey(raw, backend) } finally { raw.fill(0) }
}
async function seal(key: AesKey, data: Json, kdf: EncryptedRing['kdf'], createdAt?: string): Promise<EncryptedRing> {
  const iv = rand(12)
  const ct = await key.seal(iv, new TextEncoder().encode(JSON.stringify(data)), AAD)
  const now = new Date().toISOString()
  return { v: 2, kdf, cipher: 'AES-256-GCM', iv: base64.encode(iv), ct: base64.encode(ct), createdAt: createdAt ?? now, changedAt: now }
}
async function open(key: AesKey, blob: EncryptedRing): Promise<Json> {
  let pt: Uint8Array
  try { pt = await key.open(base64.decode(blob.iv), base64.decode(blob.ct), AAD) } catch { throw new WrongPassphrase() }
  return JSON.parse(new TextDecoder().decode(pt))
}

export class KeyStore {
  private data: Json | null = null
  private key: AesKey | null = null
  private blob: EncryptedRing | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  private writing: Promise<void> = Promise.resolve()
  private version = 0
  /** backend: force 'webcrypto' or 'js' (tests); default = WebCrypto when available, else pure JS. */
  opts: { N?: number; idleMs?: number; storage?: Storage; backend?: CryptoBackend }
  constructor(opts: { N?: number; idleMs?: number; storage?: Storage; backend?: CryptoBackend } = {}) { this.opts = opts }
  /** Which AES implementation the unlocked key uses (null while locked). */
  get backend(): CryptoBackend | null { return this.key?.backend ?? null }
  private derive(pass: string, kdf: EncryptedRing['kdf'], onProgress?: OnProgress) { return deriveKey(pass, kdf, this.opts.backend, onProgress) }

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
  async create(pass: string, onProgress?: OnProgress) {
    if (this.state() !== 'empty') throw new Error('A keyring already exists on this device')
    this.check(pass)
    const kdf = this.newKdf()
    this.key = await this.derive(pass, kdf, onProgress)
    this.data = {}
    this.blob = await seal(this.key, this.data, kdf)
    this.storage.setItem(STORE_KEY, JSON.stringify(this.blob))
    this.armIdle(); this.emit()
  }
  /** Encrypt existing plaintext (v1) keys, verify the ciphertext decrypts back identically, then delete the plaintext. */
  async migrate(pass: string, onProgress?: OnProgress) {
    if (this.state() !== 'legacy') throw new Error('Nothing to migrate')
    this.check(pass)
    const legacy = JSON.parse(this.storage.getItem(LEGACY_KEY)!) as Json
    const kdf = this.newKdf()
    const key = await this.derive(pass, kdf, onProgress)
    const blob = await seal(key, legacy, kdf)
    if (JSON.stringify(await open(key, blob)) !== JSON.stringify(legacy)) throw new Error('Migration self-check failed; plaintext kept')
    this.storage.setItem(STORE_KEY, JSON.stringify(blob))
    this.storage.removeItem(LEGACY_KEY)
    this.key = key; this.blob = blob; this.data = legacy
    this.armIdle(); this.emit()
  }
  async unlock(pass: string, onProgress?: OnProgress) {
    const blob = this.readBlob()
    if (!blob) throw new Error('No encrypted keyring on this device')
    const key = await this.derive(pass, blob.kdf, onProgress)
    try { this.data = await open(key, blob) } catch (e) { key.destroy(); throw e }
    this.key = key; this.blob = blob
    this.armIdle(); this.emit()
  }
  lock() {
    if (this.timer) clearTimeout(this.timer)
    // forget the key once queued encrypted writes (update()) have finished with it
    const k = this.key
    if (k) this.writing.finally(() => k.destroy()).catch(() => {})
    this.timer = null; this.data = null; this.key = null; this.blob = null
    this.emit()
  }
  /** Re-encrypt under a new passphrase with a fresh salt; the current passphrase must be correct. */
  async changePassphrase(current: string, next: string, onProgress?: OnProgress) {
    this.check(next)
    const blob = this.readBlob()
    if (!blob) throw new Error('No encrypted keyring on this device')
    const old = await this.derive(current, blob.kdf, onProgress && ((f) => onProgress(f / 2)))
    const data = await open(old, blob).finally(() => old.destroy())
    await this.writing
    const kdf = this.newKdf()
    const key = await this.derive(next, kdf, onProgress && ((f) => onProgress(0.5 + f / 2)))
    const prev = this.key
    this.blob = await seal(key, data, kdf, blob.createdAt)
    this.storage.setItem(STORE_KEY, JSON.stringify(this.blob))
    this.key = key; this.data = data
    if (prev && prev !== key) prev.destroy()
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
