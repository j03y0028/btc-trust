import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { CryptoUnavailable, MIN_PASSPHRASE, WrongPassphrase, keyStore, LEGACY_KEY } from '../lib/keystore'
import { hasWebCrypto } from '../lib/aead'
import { StrengthMeter } from './VaultParts'
import { Modal } from './Modal'

export const useKeyState = () => { useSyncExternalStore(keyStore.subscribe, keyStore.getVersion); return keyStore.state() }

function legacyCount() {
  try { return Object.values(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '{}') as Record<string, object>).reduce((n, w) => n + Object.keys(w).length, 0) } catch { return 0 }
}

/** Messages from the keystore that are already written for people; anything else is an unexpected failure. */
const USER_FACING = [/^Passphrase must be/, /^A keyring already exists/, /^Nothing to migrate/, /^No encrypted keyring/, /^Migration self-check failed/]
export function keyError(err: unknown, wrong = 'Wrong passphrase. Nothing was decrypted.'): { text: string; detail?: string } {
  if (err instanceof WrongPassphrase) return { text: wrong }
  if (err instanceof CryptoUnavailable) return { text: err.message }
  const msg = (err as Error)?.message ?? String(err)
  if (USER_FACING.some((r) => r.test(msg))) return { text: msg }
  return { text: 'Something went wrong while encrypting or decrypting your trustee keys. Nothing was changed on this device. Please try again; if it keeps happening, try another browser or open the app over HTTPS.', detail: msg }
}

/** Key derivation progress (0..100), updated at most once per percent. */
export function useProgress() {
  const [pct, setPct] = useState<number | null>(null)
  const last = { v: -1 }
  const on = (f: number) => { const v = Math.floor(f * 100); if (v !== last.v) { last.v = v; setPct(v) } }
  return { pct, start: () => { last.v = -1; setPct(0); return on }, done: () => setPct(null) }
}

export function Progress({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) return null
  return (
    <div className="kg-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-testid="kdf-progress">
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Shown when the page is plain HTTP on a LAN address: everything works, just in pure JS (and per-address storage). */
export function InsecureNote() {
  if (typeof window === 'undefined' || window.isSecureContext !== false) return null
  const js = !hasWebCrypto()
  return (
    <p className="kg-note" data-testid="insecure-note">
      ⓘ You opened BTC Trust over plain HTTP ({location.host}). {js ? 'Your browser hides its built-in crypto here, so encryption runs in audited JavaScript (same format, a few seconds slower). ' : ''}
      For the best protection use <b>https://mynode.local:9331</b>. Keys are stored per address, so keep using the same address.
    </p>
  )
}

/** Gate for anything that needs trustee secret keys: create / migrate / unlock, then render children. */
export function KeyGate({ children }: { children: ReactNode }) {
  const state = useKeyState()
  useEffect(() => {
    const touch = () => keyStore.touch()
    window.addEventListener('pointerdown', touch); window.addEventListener('keydown', touch)
    return () => { window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch) }
  }, [])
  if (state === 'unlocked') return <>{children}<KeyBar /></>
  return <KeyPrompt state={state} />
}

function KeyPrompt({ state }: { state: 'empty' | 'legacy' | 'locked' }) {
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null)
  const progress = useProgress()
  const isNew = state !== 'locked'
  const valid = isNew ? pass.length >= MIN_PASSPHRASE && pass === confirm : pass.length > 0
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    const onProgress = progress.start()
    try {
      if (state === 'locked') await keyStore.unlock(pass, onProgress)
      else if (state === 'legacy') await keyStore.migrate(pass, onProgress)
      else await keyStore.create(pass, onProgress)
    } catch (err) { setError(keyError(err)) } finally { setBusy(false); progress.done() }
  }
  const n = state === 'legacy' ? legacyCount() : 0
  return (
    <div className="keygate-wrap">
      <form className="glass card keygate" onSubmit={submit} data-testid={`keygate-${state}`}>
        <div className="kg-lock" aria-hidden><span>{state === 'locked' ? '🔒' : state === 'legacy' ? '⚠' : '🔑'}</span></div>
        <h2>{state === 'locked' ? 'Trustee keys are locked' : state === 'legacy' ? 'Protect your trustee keys' : 'Set a passphrase for trustee keys'}</h2>
        <p className="muted small">
          {state === 'locked' && 'Your Ed25519 signing and X25519 encryption keys are encrypted on this device. Unlock them to read and send trustee messages.'}
          {state === 'legacy' && <>Found <b>{n} trustee key{n === 1 ? '' : 's'}</b> stored unencrypted by an earlier version. Choose a passphrase: they will be encrypted, verified, and the plaintext copy deleted.</>}
          {state === 'empty' && 'Messaging keys are generated in this browser. They are encrypted at rest with this passphrase before you enroll as a trustee.'}
        </p>
        <label className="field-label" htmlFor="kg-pass">Passphrase</label>
        <input id="kg-pass" type="password" autoFocus autoComplete={isNew ? 'new-password' : 'current-password'} value={pass} onChange={(e) => setPass(e.target.value)} placeholder={isNew ? `At least ${MIN_PASSPHRASE} characters` : 'Passphrase'} />
        {isNew && <><StrengthMeter value={pass} />
          <label className="field-label" htmlFor="kg-confirm">Confirm passphrase</label>
          <input id="kg-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {confirm && confirm !== pass && <span className="field-error">Passphrases do not match</span>}</>}
        {error && <div className="field-error" role="alert">{error.text}{error.detail && <details className="kg-detail"><summary>Details</summary><code>{error.detail}</code></details>}</div>}
        <button className="btn primary kg-btn" disabled={!valid || busy}>{busy ? <><span className="kg-spin" aria-hidden />Deriving key (scrypt) {progress.pct ?? 0}%</> : state === 'locked' ? 'Unlock' : state === 'legacy' ? 'Encrypt & migrate' : 'Create encrypted keyring'}</button>
        <Progress pct={progress.pct} label="Deriving key" />
        {busy && <span className="muted small kg-wait">This takes a few seconds on purpose: it makes guessing your passphrase slow.</span>}
        <InsecureNote />
        <div className="kg-spec">
          <span>scrypt N=2¹⁷ · r=8 · p=1</span><span>AES-256-GCM</span><span>auto-lock after 5 min idle</span><span>never sent to the server</span>
        </div>
      </form>
    </div>
  )
}

function KeyBar() {
  const [change, setChange] = useState(false)
  return (
    <div className="keybar" data-testid="keybar">
      <span className="kb-dot" /> Trustee keys unlocked
      <button className="link small" onClick={() => setChange(true)}>Change passphrase</button>
      <button className="btn small" onClick={() => keyStore.lock()}>🔒 Lock</button>
      {change && <ChangePassphrase onClose={() => setChange(false)} />}
    </div>
  )
}

function ChangePassphrase({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('')
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null), [busy, setBusy] = useState(false)
  const progress = useProgress()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try { await keyStore.changePassphrase(cur, next, progress.start()); onClose() } catch (err) { setError(keyError(err, 'Current passphrase is wrong')) } finally { setBusy(false); progress.done() }
  }
  return (
    <Modal title="Change trustee key passphrase" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Current passphrase<input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>
        <label>New passphrase<input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
        <StrengthMeter value={next} />
        <label>Confirm new passphrase<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
        {error && <div className="field-error" role="alert">{error.text}{error.detail && <details className="kg-detail"><summary>Details</summary><code>{error.detail}</code></details>}</div>}
        <p className="muted small">Keys are re-encrypted with a fresh salt; the old ciphertext is replaced.</p>
        <button className="btn primary" disabled={busy || !cur || next.length < MIN_PASSPHRASE || next !== confirm}>{busy ? <><span className="kg-spin" aria-hidden />Re-encrypting {progress.pct ?? 0}%</> : 'Change passphrase'}</button>
        <Progress pct={progress.pct} label="Re-encrypting" />
      </form>
    </Modal>
  )
}
