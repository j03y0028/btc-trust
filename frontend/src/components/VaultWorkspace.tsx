import { useCallback, useEffect, useRef, useState } from 'react'
import type { Wallet } from '../lib/api'
import { DOC_META, DOC_ORDER, mmss, saveBlob, vaultApi, vaultSession, type DocSummary, type DocType, type VaultStatus } from '../lib/vault'
import { Modal } from './Modal'
import { DocEditor } from './DocEditor'
import { SecondFactorPicker, StrengthMeter } from './VaultParts'

const PING_EVERY_MS = 20_000

export function VaultWorkspace({ wallet, status, onLock, onStatus }: { wallet: Wallet; status: VaultStatus; onLock: () => void; onStatus: () => void }) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<'passphrase' | 'second-factor' | null>(null)
  const [left, setLeft] = useState(status.expiresInMs ?? status.idleMs)
  const deadline = useRef(Date.now() + (status.expiresInMs ?? status.idleMs))
  const lastPing = useRef(Date.now())

  const touch = useCallback(() => { deadline.current = Date.now() + status.idleMs; lastPing.current = Date.now() }, [status.idleMs])

  const load = useCallback(async () => {
    try {
      const d = await vaultApi.list(wallet.id); touch(); setDocs(d)
      setSelected((s) => s ?? d[0]?.id ?? null)
    } catch (e) { setError((e as Error).message) }
  }, [wallet.id, touch])
  useEffect(() => { load() }, [load])

  // Inactivity auto-lock: server enforces idleMs; the UI mirrors it and keeps the session alive while you work.
  useEffect(() => {
    const t = setInterval(() => {
      const ms = deadline.current - Date.now()
      setLeft(ms)
      if (ms <= 0) { vaultSession.clear(wallet.id) }
    }, 1000)
    const activity = () => {
      if (Date.now() - lastPing.current < PING_EVERY_MS) return
      lastPing.current = Date.now()
      vaultApi.ping(wallet.id).then(touch).catch(() => {})
    }
    window.addEventListener('keydown', activity)
    window.addEventListener('pointerdown', activity)
    return () => { clearInterval(t); window.removeEventListener('keydown', activity); window.removeEventListener('pointerdown', activity) }
  }, [wallet.id, touch])

  const newDoc = async (type: DocType) => {
    try {
      const t = await vaultApi.template(wallet.id, type)
      const d = await vaultApi.createDoc(wallet.id, { type, title: t.title, content: t.content })
      await load(); setSelected(d.id)
    } catch (e) { setError((e as Error).message) }
  }
  const exportBackup = async () => {
    try {
      const b = await vaultApi.backup(wallet.id); touch()
      saveBlob(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }), `${wallet.name.replace(/\W+/g, '-').toLowerCase()}-vault-backup-${new Date().toISOString().slice(0, 10)}.json`)
    } catch (e) { setError((e as Error).message) }
  }

  const pct = Math.max(0, Math.min(1, left / status.idleMs))
  const anchored = docs?.filter((d) => d.latest.anchored).length ?? 0
  const byType = DOC_ORDER.map((t) => [t, docs?.filter((d) => d.type === t) ?? []] as const)

  return (
    <>
      <section className="glass card vault-bar" data-testid="vault-unlocked">
        <div className="vault-bar-main">
          <div className="vault-open-icon" aria-hidden>🔓</div>
          <div>
            <span className="eyebrow">Trust vault · {wallet.name}</span>
            <h2 className="vault-title sm">Unlocked <span className="vault-chip on">AES-256-GCM</span>{status.secondFactor && <span className="vault-chip sf">✍ {status.secondFactor.label}</span>}</h2>
            <span className="muted small">{docs?.length ?? 0} documents · {anchored} anchored on regtest · scrypt N=2<sup>{Math.log2(status.kdf?.N ?? 131072)}</sup></span>
          </div>
        </div>
        <div className="autolock" title="Locks automatically after inactivity" data-testid="autolock">
          <svg viewBox="0 0 36 36"><circle className="al-track" cx="18" cy="18" r="15.5" /><circle className="al-fill" cx="18" cy="18" r="15.5" style={{ strokeDasharray: `${pct * 97.4} 97.4` }} /></svg>
          <div><span className="muted small">Auto-lock in</span><strong>{mmss(left)}</strong></div>
        </div>
        <div className="vault-bar-actions">
          <button className="btn small ghost" onClick={() => setModal('passphrase')}>Change passphrase</button>
          <button className="btn small ghost" onClick={() => setModal('second-factor')}>Second factor</button>
          <button className="btn small ghost" onClick={exportBackup} data-testid="export-backup">⤓ Encrypted backup</button>
          <button className="btn small primary" onClick={onLock} data-testid="vault-lock">🔒 Lock</button>
        </div>
      </section>

      <div className="disclaimer" role="note"><strong>Not legal advice.</strong> Templates are educational starting points for documenting a Bitcoin trust. Have a qualified attorney in your jurisdiction review any trust instrument before relying on it.</div>
      {error && <div className="glass alert" role="alert" onClick={() => setError(null)}>⚠ {error}</div>}

      <section className="vault-grid">
        <aside className="glass card doc-list">
          <div className="card-title"><h2>Documents</h2><span className="pill">{docs?.length ?? 0}</span></div>
          {byType.map(([t, list]) => (
            <div key={t} className="doc-group">
              <div className="doc-group-head"><span>{DOC_META[t].icon} {DOC_META[t].label}</span>
                <button className="icon-btn sm" onClick={() => newDoc(t)} title={`New ${DOC_META[t].label} from template`} aria-label={`New ${DOC_META[t].label}`}>＋</button></div>
              {list.map((d) => (
                <button key={d.id} className={`doc-item ${selected === d.id ? 'active' : ''}`} onClick={() => setSelected(d.id)} data-testid="doc-item">
                  <span className="doc-item-title">{d.title}</span>
                  <span className="doc-item-meta">v{d.latest.v} · <code>{d.latest.sha256.slice(0, 8)}</code>{d.latest.anchored && <i className="anchor-dot" title="Anchored">⚓</i>}{d.attachments > 0 && <i title="Attachments">📎{d.attachments}</i>}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>
        {selected
          ? <DocEditor key={selected} walletId={wallet.id} docId={selected} onChanged={load} onDeleted={() => { setSelected(null); load() }} touch={touch} />
          : <div className="glass card empty"><div className="empty-icon">📜</div><p>Start with a template: trust deed, beneficiaries, trustees, succession plan or descriptor backup.</p>
              <div className="row-actions center">{DOC_ORDER.slice(0, 5).map((t) => <button key={t} className="btn small" onClick={() => newDoc(t)}>{DOC_META[t].icon} {DOC_META[t].label}</button>)}</div></div>}
      </section>

      {modal === 'passphrase' && <ChangePassphrase walletId={wallet.id} onClose={() => setModal(null)} onDone={() => { setModal(null); onStatus() }} />}
      {modal === 'second-factor' && <SecondFactorModal wallet={wallet} status={status} onClose={() => setModal(null)} onDone={() => { setModal(null); onStatus() }} />}
    </>
  )
}

function ChangePassphrase({ walletId, onClose, onDone }: { walletId: string; onClose: () => void; onDone: () => void }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try { await vaultApi.changePassphrase(walletId, cur, next); onDone() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Change passphrase" onClose={onClose}>
      <form className="form" onSubmit={go}>
        <p className="hint">Re-encrypts the vault with a fresh salt and a new data key; every document and attachment is re-sealed. Other sessions are signed out. Old backups still need the old passphrase.</p>
        <label>Current passphrase<input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>
        <label>New passphrase<input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
        <StrengthMeter value={next} />
        <label>Confirm new passphrase<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
        <button className="btn primary" disabled={busy || !cur || next.length < 10 || next !== confirm}>{busy ? 'Re-encrypting…' : 'Re-encrypt vault'}</button>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Modal>
  )
}

function SecondFactorModal({ wallet, status, onClose, onDone }: { wallet: Wallet; status: VaultStatus; onClose: () => void; onDone: () => void }) {
  const [pass, setPass] = useState('')
  const [sf, setSf] = useState<{ cosigner: number; address?: string } | null>(status.secondFactor ? { cosigner: status.secondFactor.cosigner, address: status.secondFactor.address } : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try { await vaultApi.setSecondFactor(wallet.id, pass, sf); onDone() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Wallet-signature second factor" onClose={onClose}>
      <form className="form" onSubmit={go}>
        <p className="hint">When enabled, unlocking needs the passphrase <em>and</em> a fresh signmessage signature from the chosen cosigner. The setting is bound into the encrypted index, so removing it from the file is detected as tampering.</p>
        <SecondFactorPicker wallet={wallet} value={sf} onChange={setSf} />
        <label>Vault passphrase<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
        <button className="btn primary" disabled={busy || !pass}>{busy ? 'Saving…' : 'Save'}</button>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Modal>
  )
}
