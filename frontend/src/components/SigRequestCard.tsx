import { useState } from 'react'
import { btc, fmt } from '../lib/api'
import { msgApi, seal, sendEnvelope, timeOf, type DirectoryEntry, type Identity, type SecretIdentity, type SigRequest } from '../lib/messaging'
import { SigRing } from './SigRing'

const STATUS: Record<SigRequest['status'], string> = { open: 'Awaiting signatures', ready: 'Ready to broadcast', broadcast: 'Broadcast' }

export function SigRequestCard({ walletId, req, me, dir, note, onUpdate }: {
  walletId: string; req: SigRequest | undefined; me: SecretIdentity; dir: DirectoryEntry[]; note?: string; onUpdate: (r: SigRequest) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState(false)
  const [paste, setPaste] = useState('')
  if (!req) return <div className="sigreq-card loading">Loading signature request…</div>
  const label = (fp: string) => dir.find((d) => d.fingerprint === fp)?.label ?? fp
  const mine = dir.find((d) => d.fingerprint === me.fingerprint)
  const canSign = req.status === 'open' && !req.signedBy.includes(me.fingerprint) && mine && mine.kind !== 'airgapped'
  const spend = req.outputs.filter((o) => !o.isChange)
  const members = dir.filter((d) => d.identity).map((d) => d.identity!) as Identity[]

  const update = async (r: SigRequest, action: 'signed' | 'broadcast', text: string) => {
    onUpdate(r)
    const recipients = req.threadId === 'group' ? members : members.filter((m) => req.threadId.includes(m.fingerprint))
    await sendEnvelope(walletId, me, seal(walletId, me, req.threadId, recipients, { type: 'sigreq-update', requestId: req.id, action, text, signatures: r.signatures, required: r.required, txid: r.broadcastTxid }))
  }
  const run = async (k: string, fn: () => Promise<void>) => { setBusy(k); setError(null); try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) } }
  const sign = () => run('sign', async () => { const r = await msgApi.signSigRequest(walletId, me, req.id); await update(r, 'signed', `Signed (${r.signatures}/${r.required})`) })
  const merge = () => run('import', async () => { const r = await msgApi.importSigned(walletId, me, req.id, paste.trim()); setPaste(''); await update(r, 'signed', `Imported signed PSBT (${r.signatures}/${r.required})`) })
  const broadcast = () => run('broadcast', async () => { const r = await msgApi.broadcast(walletId, me, req.id); await update(r, 'broadcast', 'Broadcast to the network') })

  return (
    <div className={`sigreq-card st-${req.status} ${req.urgent ? 'urgent' : ''}`} data-testid="sigreq-card">
      <div className="sigreq-head">
        <SigRing have={req.signatures} need={req.required} />
        <div className="sigreq-title">
          <span className="eyebrow">Signature request · {label(req.createdBy)}</span>
          <strong>{spend.map((o) => `${btc(o.amount, 8)} BTC`).join(' + ') || 'Transaction'} <span className="muted">→ {spend[0] ? `${spend[0].address.slice(0, 12)}…` : ''}</span></strong>
          <span className={`sig-status s-${req.status}`} data-testid="sigreq-status">{STATUS[req.status]} · {req.signatures}/{req.required}</span>
        </div>
      </div>
      {note && <p className="sigreq-note">“{note}”</p>}
      <ul className="sigreq-signers">
        {dir.map((d) => {
          const signed = req.signedBy.includes(d.fingerprint)
          const asked = req.requestedFrom.includes(d.fingerprint)
          return <li key={d.fingerprint} className={signed ? 'signed' : asked ? 'asked' : ''}><i>{signed ? '✓' : asked ? '…' : '·'}</i>{d.label}<span className="muted small">{signed ? 'signed' : asked ? 'requested' : 'not asked'}</span></li>
        })}
      </ul>
      <ol className="sigreq-timeline">
        {req.events.map((e, i) => <li key={i}><span>{timeOf(e.at)}</span>{label(e.by)} {e.action === 'requested' ? 'requested signatures' : e.action === 'broadcast' ? 'broadcast the transaction' : e.action === 'imported' ? 'imported a signed PSBT' : 'signed'}{e.action !== 'broadcast' && <em> · {e.signatures}/{req.required}</em>}</li>)}
      </ol>
      {review && (
        <div className="sigreq-review">
          <div className="out"><span>Txid</span><code>{fmt.hash(req.txid, 14)}</code></div>
          {req.outputs.map((o, i) => <div key={i} className={`out ${o.isChange ? 'change' : ''}`}><span>{o.isChange ? 'Change' : 'Pay'}</span><code>{o.address}</code><strong>{btc(o.amount, 8)}</strong></div>)}
          <div className="out fee"><span>Fee</span><strong>{req.fee !== null ? btc(req.fee) : '?'} BTC</strong></div>
          {mine?.kind === 'airgapped' && req.status === 'open' && (
            <div className="psbt-actions">
              <button className="btn small ghost" onClick={() => navigator.clipboard?.writeText(req.psbt)}>Copy PSBT</button>
              <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste signed PSBT (base64)" />
              <button className="btn small" disabled={!paste.trim() || !!busy} onClick={merge}>Merge</button>
            </div>
          )}
        </div>
      )}
      <div className="row-actions">
        <button className="btn small ghost" onClick={() => setReview(!review)}>{review ? 'Hide PSBT' : 'Review PSBT'}</button>
        {canSign && <button className="btn small primary" disabled={!!busy} onClick={sign} data-testid="sigreq-sign">{busy === 'sign' ? (mine?.kind === 'hardware' ? 'Confirm on device…' : 'Signing…') : `✍ Sign as ${mine?.label}`}</button>}
        {req.status === 'ready' && <button className="btn small primary" disabled={!!busy} onClick={broadcast} data-testid="sigreq-broadcast">{busy === 'broadcast' ? 'Broadcasting…' : '↗ Finalize & broadcast'}</button>}
        {req.status === 'broadcast' && req.broadcastTxid && <span className="verified-badge">✓ txid {fmt.hash(req.broadcastTxid, 6)}</span>}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  )
}
