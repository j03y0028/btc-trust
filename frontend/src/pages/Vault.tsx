import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, walletApi, walletKind, type Wallet } from '../lib/api'
import { navigate } from '../lib/router'
import { vaultApi, vaultSession, type Challenge, type VaultStatus } from '../lib/vault'
import { KindBadge } from '../components/KindBadge'
import { VaultWorkspace } from '../components/VaultWorkspace'
import { SecondFactorPicker, StrengthMeter } from '../components/VaultParts'

const MIN_PASS = 10

/** #/vault — pick the wallet whose trust documentation you want to open. */
export function VaultIndex() {
  const [wallets, setWallets] = useState<(Wallet & { vault?: VaultStatus })[] | null>(null)
  useEffect(() => {
    walletApi.list().then(async (ws) => {
      const st = await Promise.all(ws.map((w) => vaultApi.status(w.id).catch(() => undefined)))
      setWallets(ws.map((w, i) => ({ ...w, vault: st[i] })))
    }).catch(() => setWallets([]))
  }, [])
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">Trust Vault</h2>
          <p className="muted">Encrypted trust documentation bound to each wallet. Encrypted on disk with your passphrase; private keys are never stored.</p>
        </div>
      </div>
      {!wallets ? <div className="glass card skeleton">Loading…</div> : (
        <div className="wallet-grid">
          {wallets.map((w) => (
            <button key={w.id} className="glass card wallet-card vault-pick" onClick={() => navigate(`/vault/${w.id}`)} data-testid={`vault-pick-${w.id}`}>
              <div className="wc-head"><span className={`kind kind-${w.type}`}>{walletKind(w)}</span>
                <span className={`vault-chip ${w.vault?.exists ? 'on' : ''}`}>{w.vault?.exists ? '🔒 Vault' : 'No vault'}</span></div>
              <div className="wc-name">{w.name}</div>
              <div className="wc-sub">{w.vault?.exists ? `${w.vault.secondFactor ? 'Passphrase + wallet signature' : 'Passphrase'} · updated ${new Date(w.vault.updatedAt!).toLocaleDateString('en-US')}` : 'Create an encrypted vault for this wallet'}</div>
            </button>
          ))}
          {wallets.length === 0 && <div className="glass card empty"><div className="empty-icon">🔐</div><p>Create a wallet first.</p></div>}
        </div>
      )}
    </main>
  )
}

export function VaultPage({ walletId }: { walletId: string }) {
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => vaultApi.status(walletId).then(setStatus).catch((e) => setError((e as Error).message)), [walletId])
  useEffect(() => {
    walletApi.list().then((ws) => setWallet(ws.find((w) => w.id === walletId) ?? null)).catch((e) => setError(e.message))
    refresh()
    return vaultSession.onLocked((w) => { if (w === walletId) refresh() })
  }, [walletId, refresh])

  const onSession = (token: string) => { vaultSession.set(walletId, token); refresh() }
  const lock = async () => { await vaultApi.lock(walletId).catch(() => {}); vaultSession.clear(walletId) }

  if (error && !status) return <main className="page"><div className="glass alert" role="alert">⚠ {error}</div></main>
  if (!status || !wallet) return <main className="page"><div className="glass card skeleton">Loading vault…</div></main>

  return (
    <main className="page">
      <button className="back" onClick={() => navigate('/vault')}>← All vaults</button>
      {status.unlocked
        ? <VaultWorkspace wallet={wallet} status={status} onLock={lock} onStatus={refresh} />
        : status.exists ? <LockedView wallet={wallet} status={status} onSession={onSession} />
        : <CreateView wallet={wallet} onSession={onSession} />}
    </main>
  )
}

function VaultHero({ wallet, children, title, sub }: { wallet: Wallet; title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="glass card vault-hero" data-testid="vault-locked">
      <div className="vault-lock-art" aria-hidden><div className="shackle" /><div className="lock-body"><span>₿</span></div></div>
      <div className="vault-hero-body">
        <span className="eyebrow">{wallet.name} · {walletKind(wallet)}</span>
        <h2 className="vault-title">{title}</h2>
        <p className="muted">{sub}</p>
        {children}
      </div>
    </section>
  )
}

function CryptoChips({ status }: { status?: VaultStatus }) {
  const N = status?.kdf?.N ?? 2 ** 17
  return (
    <div className="crypto-chips">
      <span className="chip">scrypt N=2<sup>{Math.log2(N)}</sup> · r=8 · p=1</span>
      <span className="chip">AES-256-GCM</span>
      <span className="chip">SHA-256 versioning</span>
      <span className="chip">Auto-lock {Math.round((status?.idleMs ?? 300000) / 60000)} min</span>
    </div>
  )
}

function LockedView({ wallet, status, onSession }: { wallet: Wallet; status: VaultStatus; onSession: (t: string) => void }) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [restoring, setRestoring] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try {
      const r = await vaultApi.unlock(wallet.id, pass)
      setPass('')
      if (r.unlocked) onSession(r.session); else setChallenge(r.challenge)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  if (challenge) return <ChallengeView wallet={wallet} challenge={challenge} onSession={onSession} onCancel={() => setChallenge(null)} />
  return (
    <VaultHero wallet={wallet} title="Vault locked" sub="Trust documents are encrypted at rest. Enter the vault passphrase to decrypt them in memory on the trust node.">
      <form className="form vault-form" onSubmit={unlock}>
        <label>Vault passphrase
          <input ref={input} type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••••••" data-testid="vault-passphrase" />
        </label>
        {status.secondFactor && (
          <div className="sf-note"><span className="sf-icon">✍</span><div><strong>Second factor required</strong><span className="muted small">After the passphrase, sign a challenge with <b>{status.secondFactor.label}</b> <KindBadge kind={status.secondFactor.kind as 'software'} /> to prove wallet control.</span></div></div>
        )}
        <div className="row-actions">
          <button className="btn primary" disabled={busy || !pass} data-testid="vault-unlock">{busy ? 'Deriving key…' : '🔓 Unlock vault'}</button>
          <button type="button" className="btn ghost" onClick={() => setRestoring(true)}>Restore from backup…</button>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
      <CryptoChips status={status} />
      {restoring && <RestoreForm wallet={wallet} overwrite onSession={onSession} onClose={() => setRestoring(false)} />}
    </VaultHero>
  )
}

function ChallengeView({ wallet, challenge, onSession, onCancel }: { wallet: Wallet; challenge: Challenge; onSession: (t: string) => void; onCancel: () => void }) {
  const [sig, setSig] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const verify = async (signature: string) => {
    setBusy('verify'); setError(null)
    try { onSession((await vaultApi.verifyChallenge(wallet.id, challenge.id, signature.trim())).session) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const sign = async () => {
    setBusy('sign'); setError(null)
    try { const r = await vaultApi.signChallenge(wallet.id, challenge.id); setSig(r.signature); await verify(r.signature) } catch (e) { setError((e as Error).message); setBusy(null) }
  }
  return (
    <VaultHero wallet={wallet} title="Prove wallet control" sub="Passphrase accepted. Sign this one-time challenge with the cosigner's identity key (Bitcoin signmessage, legacy P2PKH) to finish unlocking.">
      <div className="challenge" data-testid="vault-challenge">
        <div className="challenge-row"><span className="field-label">Signer</span><span><strong>{challenge.label}</strong> <KindBadge kind={challenge.kind as 'software'} /></span></div>
        <div className="challenge-row"><span className="field-label">Address</span><code>{challenge.address}</code></div>
        {challenge.path !== 'external' && <div className="challenge-row"><span className="field-label">Path</span><code>{challenge.path}</code></div>}
        <span className="field-label">Message</span>
        <pre className="challenge-msg">{challenge.message}</pre>
      </div>
      {challenge.kind !== 'airgapped' && (
        <button className="btn primary" disabled={!!busy} onClick={sign} data-testid="vault-sign">
          {busy === 'sign' ? (challenge.kind === 'hardware' ? 'Confirm on device…' : 'Signing…') : challenge.kind === 'hardware' ? '⌁ Sign on hardware wallet' : '✍ Sign with node key'}
        </button>
      )}
      <form className="form" onSubmit={(e) => { e.preventDefault(); verify(sig) }}>
        <label>{challenge.kind === 'airgapped' ? 'Signature from your offline wallet' : 'Or paste a signature from an external wallet'}
          <textarea rows={2} value={sig} onChange={(e) => setSig(e.target.value)} placeholder="H…= (base64 signmessage signature)" data-testid="vault-signature" />
        </label>
        <div className="row-actions">
          <button className="btn" disabled={!!busy || !sig.trim()}>Verify signature</button>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </VaultHero>
  )
}

function CreateView({ wallet, onSession }: { wallet: Wallet; onSession: (t: string) => void }) {
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [sf, setSf] = useState<{ cosigner: number; address?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const ok = pass.length >= MIN_PASS && pass === confirm
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try { onSession((await vaultApi.create(wallet.id, pass, sf)).session) } catch (err) { setError(err instanceof ApiError ? err.message : String(err)) } finally { setBusy(false) }
  }
  return (
    <VaultHero wallet={wallet} title="Create a trust vault" sub="Choose a long passphrase. It cannot be recovered — store it with your succession instructions, separate from the keys.">
      <form className="form vault-form" onSubmit={create}>
        <label>Passphrase<input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} data-testid="vault-new-pass" /></label>
        <StrengthMeter value={pass} />
        <label>Confirm passphrase<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="vault-confirm-pass" /></label>
        {confirm && pass !== confirm && <span className="warn-text small">Passphrases don’t match</span>}
        <SecondFactorPicker wallet={wallet} value={sf} onChange={setSf} />
        <div className="row-actions">
          <button className="btn primary" disabled={!ok || busy} data-testid="vault-create">{busy ? 'Encrypting…' : '🔐 Create vault'}</button>
          <button type="button" className="btn ghost" onClick={() => setRestoring(true)}>Restore from backup…</button>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
      <CryptoChips />
      {restoring && <RestoreForm wallet={wallet} onSession={onSession} onClose={() => setRestoring(false)} />}
    </VaultHero>
  )
}

export function RestoreForm({ wallet, overwrite, onSession, onClose }: { wallet: Wallet; overwrite?: boolean; onSession: (t: string) => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); if (!file) return
    setBusy(true); setError(null)
    try {
      const backup = JSON.parse(await file.text())
      onSession((await vaultApi.restore(wallet.id, backup, pass, overwrite)).session)
    } catch (err) { setError(err instanceof SyntaxError ? 'Not a vault backup file' : (err as Error).message) } finally { setBusy(false) }
  }
  return (
    <form className="form restore" onSubmit={go}>
      <span className="field-label">Restore encrypted backup {overwrite && <span className="warn-text">(replaces the current vault)</span>}</span>
      <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <input type="password" placeholder="Backup passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
      <div className="row-actions">
        <button className="btn" disabled={!file || !pass || busy}>{busy ? 'Verifying…' : 'Verify & restore'}</button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </form>
  )
}
