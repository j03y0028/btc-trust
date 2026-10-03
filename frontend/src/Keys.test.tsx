import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_KDF, KeyStore, LEGACY_KEY, STORE_KEY, WrongPassphrase, keyStore } from './lib/keystore'
import { messageHash, verifyAttestation, verifyMessage } from './lib/btcmessage'
import { KeyGate } from './components/KeyGate'
import { checkDirectory, keyring, N, type DirectoryEntry } from './lib/messaging'
import { newIdentity } from '../../shared/msgcrypto'
import { attest } from './test-btc'

const PASS = 'correct horse battery'
const mk = (idleMs = 0) => new KeyStore({ N: 2 ** 10, idleMs })
beforeEach(() => { keyStore.lock(); localStorage.clear() })
afterEach(() => vi.useRealTimers())

describe('encrypted trustee keystore', () => {
  it('production default is scrypt N=2^17, r=8, p=1 with AES-256-GCM', async () => {
    const s = new KeyStore({ idleMs: 0 })
    expect(s.opts.N).toBeUndefined()
    expect(DEFAULT_KDF).toEqual({ N: 131072, r: 8, p: 1 })
    const fast = mk()
    await fast.create(PASS)
    const blob = JSON.parse(localStorage.getItem(STORE_KEY)!)
    expect(blob).toMatchObject({ v: 2, cipher: 'AES-256-GCM', kdf: { name: 'scrypt', r: 8, p: 1 } })
    expect(atob(blob.kdf.salt)).toHaveLength(16)
    expect(atob(blob.iv)).toHaveLength(12)
  }, 30_000)
  it('stores only ciphertext; unlock decrypts; wrong passphrase fails; lock clears memory', async () => {
    const s = mk()
    await s.create(PASS)
    const id = newIdentity(N, 'aaaaaaaa')
    await s.update((r) => { r.w1 = { aaaaaaaa: { current: id, previous: [] } } })
    const raw = localStorage.getItem(STORE_KEY)!
    expect(raw).not.toContain(id.signSecret)
    expect(raw).not.toContain(id.boxSecret)
    s.lock()
    expect(s.state()).toBe('locked')
    expect(s.ring).toBeNull()
    await expect(s.unlock('wrong passphrase!!')).rejects.toBeInstanceOf(WrongPassphrase)
    await s.unlock(PASS)
    expect((s.ring as any).w1.aaaaaaaa.current.signSecret).toBe(id.signSecret)
  })
  it('every write uses a fresh IV; tampered ciphertext is rejected', async () => {
    const s = mk()
    await s.create(PASS)
    const iv1 = JSON.parse(localStorage.getItem(STORE_KEY)!).iv
    await s.update((r) => { r.x = 1 })
    const blob = JSON.parse(localStorage.getItem(STORE_KEY)!)
    expect(blob.iv).not.toBe(iv1)
    const ct = Uint8Array.from(atob(blob.ct), (c) => c.charCodeAt(0)); ct[3] ^= 1
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...blob, ct: btoa(String.fromCharCode(...ct)) }))
    s.lock()
    await expect(s.unlock(PASS)).rejects.toBeInstanceOf(WrongPassphrase)
  })
  it('auto-locks after inactivity; activity resets the timer', async () => {
    vi.useFakeTimers()
    const s = mk(1000)
    await s.create(PASS)
    vi.advanceTimersByTime(800); s.touch(); vi.advanceTimersByTime(800)
    expect(s.state()).toBe('unlocked')
    vi.advanceTimersByTime(300)
    expect(s.state()).toBe('locked')
  })
  it('change passphrase re-encrypts with a new salt; old passphrase stops working', async () => {
    const s = mk()
    await s.create(PASS)
    await s.update((r) => { r.k = 'secret' })
    const salt = JSON.parse(localStorage.getItem(STORE_KEY)!).kdf.salt
    await expect(s.changePassphrase('not the passphrase', 'another long phrase')).rejects.toBeInstanceOf(WrongPassphrase)
    await s.changePassphrase(PASS, 'another long phrase')
    expect(JSON.parse(localStorage.getItem(STORE_KEY)!).kdf.salt).not.toBe(salt)
    s.lock()
    await expect(s.unlock(PASS)).rejects.toBeInstanceOf(WrongPassphrase)
    await s.unlock('another long phrase')
    expect(s.ring).toEqual({ k: 'secret' })
  })
  it('migrates plaintext v1 keys: encrypts, verifies, deletes the plaintext', async () => {
    const id = newIdentity(N, 'bbbbbbbb')
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ w1: { bbbbbbbb: { current: id, previous: [] } } }))
    const s = mk()
    expect(s.state()).toBe('legacy')
    await expect(s.migrate('short')).rejects.toThrow(/at least 10/)
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull()
    await s.migrate(PASS)
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(localStorage.getItem(STORE_KEY)).not.toContain(id.signSecret)
    s.lock(); await s.unlock(PASS)
    expect((s.ring as any).w1.bbbbbbbb.current).toEqual(id)
  })
  it('keyring refuses to store keys while locked', async () => {
    expect(keyring.locked()).toBe(true)
    expect(keyring.all('w1')).toEqual([])
    expect(() => keyring.put('w1', newIdentity(N, 'cccccccc'))).toThrow(/locked/)
  })
})

describe('client-side Bitcoin attestation check (BIP-137)', () => {
  // Real signature produced by Bitcoin Core 31.1 `signmessage` on regtest (Stage 5 demo trustee enrollment, re-signed for the demo label).
  const core = {
    walletId: 'family-trust-vault-30c585', fingerprint: '51dacbb1', label: 'Jordan',
    signPub: 'jlgTXvLK3fblH1Lky8q42fa+idhjwSINoOAyQhAF4G8=', boxPub: '1Tp+pJ9qhZXOdzCi5x6OiSjoIB2b35ZixQA0YW/o8n4=', issuedAt: '2026-10-03T03:46:06.216Z',
    statement: 'BTC Trust trustee attestation v1\nwallet: family-trust-vault-30c585\ncosigner: 51dacbb1 (Jordan)\ned25519: jlgTXvLK3fblH1Lky8q42fa+idhjwSINoOAyQhAF4G8=\nx25519: 1Tp+pJ9qhZXOdzCi5x6OiSjoIB2b35ZixQA0YW/o8n4=\nissued: 2026-10-03T03:46:06.216Z',
    btcAddress: 'mtehPidqHWJ2uhDdpasCaZVUvT31GD2uM5',
    btcSignature: 'IKqLI25AmDMt5aobGrnTzp0ia4YIumi1tpTRbpPjPywBBWP8SwE42GOE3CuKS99+ydLBVLpLjFpZ/50xyElLNFs=',
  }
  it('verifies a real Bitcoin Core signmessage signature', () => {
    expect(verifyMessage(core.btcAddress, core.btcSignature, core.statement)).toEqual({ ok: true, address: core.btcAddress, network: 'test/regtest' })
    expect(verifyAttestation(core.walletId, core)).toMatchObject({ ok: true })
  })
  it('rejects a changed message, other address, swapped keys and garbage', () => {
    expect(verifyMessage(core.btcAddress, core.btcSignature, core.statement + ' ')).toMatchObject({ ok: false, reason: /different key/ })
    expect(verifyMessage('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', core.btcSignature, core.statement)).toMatchObject({ ok: false })
    expect(verifyAttestation(core.walletId, { ...core, boxPub: core.signPub })).toMatchObject({ ok: false, reason: /does not match/ })
    expect(verifyAttestation('other-wallet', core)).toMatchObject({ ok: false })
    expect(verifyMessage(core.btcAddress, 'not base64!', core.statement)).toMatchObject({ ok: false })
    expect(verifyMessage('bcrt1qxyz', core.btcSignature, core.statement)).toMatchObject({ ok: false, reason: /P2PKH/ })
  })
  it('message hash matches the Bitcoin envelope (magic + varints, double SHA-256)', () => {
    expect(messageHash('')).toHaveLength(32)
    expect(Array.from(messageHash('a')).join()).not.toBe(Array.from(messageHash('b')).join())
  })
  it('checkDirectory drops identities whose attestation fails in the browser', () => {
    const a = newIdentity(N, 'aaaaaaaa'), b = newIdentity(N, 'bbbbbbbb')
    const id = (i: typeof a, label: string, seed: number) => ({ fingerprint: i.fingerprint, signPub: i.signPub, boxPub: i.boxPub, cosigner: seed, label, kind: 'software', ...attest('w1', { fingerprint: i.fingerprint, label, signPub: i.signPub, boxPub: i.boxPub }, seed), btcPath: '', attestedAt: '', safetyNumber: '', verified: true as const })
    const forged = { ...id(b, 'Avery', 1), boxPub: newIdentity(N, 'x').boxPub } // server swapped the encryption key
    const dir: DirectoryEntry[] = [
      { cosigner: 0, fingerprint: 'aaaaaaaa', label: 'Jordan', kind: 'software', identity: id(a, 'Jordan', 0), previousKeys: [] },
      { cosigner: 1, fingerprint: 'bbbbbbbb', label: 'Avery', kind: 'software', identity: forged, previousKeys: [] },
    ]
    const out = checkDirectory('w1', dir)
    expect(out[0].identity).not.toBeNull()
    expect(out[0].browserCheck?.ok).toBe(true)
    expect(out[1].identity).toBeNull()
    expect(out[1].rejected).toBe(forged)
  })
})

describe('KeyGate', () => {
  it('locked: prompts, rejects a wrong passphrase, unlocks and shows children + lock bar', async () => {
    await keyStore.create(PASS); keyStore.lock()
    render(<KeyGate><div>secret area</div></KeyGate>)
    expect(screen.getByTestId('keygate-locked')).toBeInTheDocument()
    expect(screen.queryByText('secret area')).toBeNull()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'nope nope nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Wrong passphrase/)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText('secret area')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Lock/ }))
    await waitFor(() => expect(screen.getByTestId('keygate-locked')).toBeInTheDocument())
  })
  it('legacy plaintext keys: offers migration and requires matching passphrases', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ w1: { aaaaaaaa: { current: newIdentity(N, 'aaaaaaaa'), previous: [] } } }))
    render(<KeyGate><div>inside</div></KeyGate>)
    expect(screen.getByTestId('keygate-legacy')).toHaveTextContent('1 trustee key')
    const btn = screen.getByRole('button', { name: 'Encrypt & migrate' })
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS + 'x' } })
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
    fireEvent.click(btn)
    expect(await screen.findByText('inside')).toBeInTheDocument()
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })
})
