// Plain-HTTP LAN access (e.g. http://192.168.1.119 on a myNode): browsers hide crypto.subtle there.
// The keyring must still work (pure-JS AES-GCM fallback), stay byte-compatible with WebCrypto, and fail politely.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { CryptoUnavailable, cryptoBackend, importAesKey, randomBytes } from './lib/aead'
import { KeyStore, STORE_KEY, WrongPassphrase, keyStore } from './lib/keystore'
import { KeyGate, keyError } from './components/KeyGate'
import { CopyButton } from './components/CopyButton'
import { copyText } from './lib/clipboard'
import fixture from './fixtures/keyring-v084-webcrypto.json'

const realCrypto = globalThis.crypto
/** What a browser exposes on http://<LAN IP>: getRandomValues yes, subtle no. */
const insecureCrypto = () => vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
const setSecure = (v: boolean) => Object.defineProperty(window, 'isSecureContext', { value: v, configurable: true })
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m } as unknown as Storage & { m: Map<string, string> } }
const PASS = 'whitfield trustee keyring'
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)

beforeEach(() => { keyStore.lock(); localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); setSecure(true) })

describe('AES-256-GCM: WebCrypto and pure-JS produce identical bytes', () => {
  const key = bytes(32, 7), iv = bytes(12, 3), aad = new TextEncoder().encode('btctrust-keyring-v2')
  const pt = new TextEncoder().encode(JSON.stringify({ 'Avery Whitfield': { secret: 'x'.repeat(300) } }))
  it('same ciphertext+tag as WebCrypto and as OpenSSL (node:crypto)', async () => {
    const web = await (await importAesKey(key, 'webcrypto')).seal(iv, pt, aad)
    const js = await (await importAesKey(key, 'js')).seal(iv, pt, aad)
    const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(aad)
    const ossl = new Uint8Array(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]))
    expect(js).toEqual(web)
    expect(js).toEqual(ossl)
    expect(js.length).toBe(pt.length + 16)
  })
  it('each opens what the other sealed; a wrong key or tampered byte is refused by both', async () => {
    const web = await importAesKey(key, 'webcrypto'), js = await importAesKey(key, 'js')
    expect(await js.open(iv, await web.seal(iv, pt, aad), aad)).toEqual(pt)
    expect(await web.open(iv, await js.seal(iv, pt, aad), aad)).toEqual(pt)
    const ct = await js.seal(iv, pt, aad); ct[5] ^= 1
    await expect(js.open(iv, ct, aad)).rejects.toThrow()
    await expect(web.open(iv, ct, aad)).rejects.toThrow()
    const other = await importAesKey(bytes(32, 8), 'js')
    await expect(other.open(iv, await js.seal(iv, pt, aad), aad)).rejects.toThrow()
  })
  it('picks WebCrypto when present, pure JS when crypto.subtle is missing', async () => {
    expect(cryptoBackend()).toBe('webcrypto')
    insecureCrypto()
    expect(globalThis.crypto.subtle).toBeUndefined()
    expect(cryptoBackend()).toBe('js')
    expect((await importAesKey(key)).backend).toBe('js')
    expect(randomBytes(16)).toHaveLength(16)   // getRandomValues still works in insecure contexts
  })
  it('a destroyed (locked) pure-JS key cannot be used', async () => {
    const k = await importAesKey(key, 'js'); k.destroy()
    await expect(k.seal(iv, pt, aad)).rejects.toThrow(/locked/)
  })
})

describe('keyring without crypto.subtle (plain-HTTP LAN access)', () => {
  it('create → lock → unlock → update works; wrong passphrase still refused', async () => {
    insecureCrypto()
    const s = new KeyStore({ N: 2 ** 10, idleMs: 0, storage: mem() })
    await s.create(PASS)
    expect(s.backend).toBe('js')
    await s.update((r) => { r.w = { 'Mateo Whitfield': 1 } })
    s.lock()
    await expect(s.unlock('not the passphrase')).rejects.toBeInstanceOf(WrongPassphrase)
    await s.unlock(PASS)
    expect(s.ring).toEqual({ w: { 'Mateo Whitfield': 1 } })
  })
  it('keyrings move between WebCrypto and pure JS in both directions (same on-disk format)', async () => {
    const storage = mem()
    const web = new KeyStore({ N: 2 ** 10, idleMs: 0, storage, backend: 'webcrypto' })
    await web.create(PASS); await web.update((r) => { r.made = 'webcrypto' }); web.lock()
    const blobWeb = storage.getItem(STORE_KEY)!
    insecureCrypto()
    const js = new KeyStore({ N: 2 ** 10, idleMs: 0, storage })
    await js.unlock(PASS)
    expect(js.backend).toBe('js')
    expect(js.ring).toEqual({ made: 'webcrypto' })
    await js.update((r) => { r.made = 'js' }); js.lock()
    const blobJs = JSON.parse(storage.getItem(STORE_KEY)!)
    expect(Object.keys(blobJs).sort()).toEqual(Object.keys(JSON.parse(blobWeb)).sort())
    expect(blobJs).toMatchObject({ v: 2, cipher: 'AES-256-GCM', kdf: { name: 'scrypt', N: 1024, r: 8, p: 1 } })
    vi.unstubAllGlobals()
    const back = new KeyStore({ N: 2 ** 10, idleMs: 0, storage, backend: 'webcrypto' })
    await back.unlock(PASS)
    expect(back.backend).toBe('webcrypto')
    expect(back.ring).toEqual({ made: 'js' })
  })
  it('a real v0.8.4 keyring (WebCrypto, scrypt N=2^17) unlocks with the pure-JS fallback', async () => {
    insecureCrypto()
    const storage = mem(); storage.setItem(STORE_KEY, JSON.stringify(fixture.blob))
    const s = new KeyStore({ idleMs: 0, storage })
    const progress: number[] = []
    await s.unlock(fixture.passphrase, (f) => progress.push(f))
    expect(s.ring).toEqual(fixture.ring)
    expect(s.backend).toBe('js')
    expect(progress.length).toBeGreaterThan(3)
    expect(progress.at(-1)).toBe(1)
  }, 60_000)
  it('change passphrase works without WebCrypto', async () => {
    insecureCrypto()
    const s = new KeyStore({ N: 2 ** 10, idleMs: 0, storage: mem() })
    await s.create(PASS); await s.update((r) => { r.a = 1 })
    await s.changePassphrase(PASS, 'a brand new passphrase')
    s.lock()
    await s.unlock('a brand new passphrase')
    expect(s.ring).toEqual({ a: 1 })
  })
  it('locking right after an update still saves the update', async () => {
    insecureCrypto()
    const storage = mem()
    const s = new KeyStore({ N: 2 ** 10, idleMs: 0, storage })
    await s.create(PASS)
    const w = s.update((r) => { r.late = true }); s.lock(); await w
    await s.unlock(PASS)
    expect(s.ring).toEqual({ late: true })
  })
  it('no secure random generator at all → a friendly CryptoUnavailable, nothing stored', async () => {
    vi.stubGlobal('crypto', {})
    const storage = mem()
    const s = new KeyStore({ N: 2 ** 10, idleMs: 0, storage })
    const err = await s.create(PASS).catch((e) => e)
    expect(err).toBeInstanceOf(CryptoUnavailable)
    expect(err.message).toMatch(/^This browser could not run the encryption needed for trustee keys/)
    expect(storage.getItem(STORE_KEY)).toBeNull()
  })
})

describe('KeyGate UI over plain HTTP', () => {
  it('creates the keyring with a progress bar and shows the plain-HTTP note (the v0.8.4 Safari bug)', async () => {
    insecureCrypto(); setSecure(false)
    const n = keyStore.opts.N; keyStore.opts.N = 2 ** 15   // slow enough to see the progress bar
    onTestFinished(() => { keyStore.opts.N = n })
    render(<KeyGate><div>messages</div></KeyGate>)
    expect(screen.getByTestId('insecure-note')).toHaveTextContent(/plain HTTP.*audited JavaScript.*https:\/\/mynode\.local:9331/)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Create encrypted keyring' }))
    expect(await screen.findByRole('progressbar', { name: 'Deriving key' })).toBeInTheDocument()
    expect(await screen.findByText('messages', {}, { timeout: 20_000 })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(keyStore.backend).toBe('js')
  }, 30_000)
  it('no note on a secure context', () => {
    setSecure(true)
    render(<KeyGate><div /></KeyGate>)
    expect(screen.queryByTestId('insecure-note')).not.toBeInTheDocument()
  })
  it('raw JS errors are never shown as the message (details are tucked away)', () => {
    const raw = keyError(new TypeError("undefined is not an object (evaluating 'Bo().importKey')"))
    expect(raw.text).toMatch(/^Something went wrong while encrypting or decrypting your trustee keys\. Nothing was changed/)
    expect(raw.text).not.toMatch(/undefined|importKey/)
    expect(raw.detail).toContain('importKey')
    expect(keyError(new WrongPassphrase()).text).toBe('Wrong passphrase. Nothing was decrypted.')
    expect(keyError(new Error('Passphrase must be at least 10 characters')).text).toBe('Passphrase must be at least 10 characters')
  })
  it('a browser with no crypto at all gets the friendly message in the form', async () => {
    vi.stubGlobal('crypto', {}); setSecure(false)
    render(<KeyGate><div>messages</div></KeyGate>)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Create encrypted keyring' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/This browser could not run the encryption needed for trustee keys/)
    expect(screen.queryByText('messages')).not.toBeInTheDocument()
  })
})

describe('copy buttons over plain HTTP (no navigator.clipboard)', () => {
  it('falls back to execCommand("copy"); says so honestly when blocked', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    expect(await copyText('bcrt1qwhitfield')).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    render(<CopyButton text="bcrt1qwhitfield" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copied ✓' })).toBeInTheDocument()
    exec.mockReturnValue(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument(), { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: /Copy blocked/ })).toBeInTheDocument()
  })
})
