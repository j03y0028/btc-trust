import { useEffect, useState } from 'react'
import { btc, type PsbtInfo, type Wallet } from '../lib/api'
import { navigate } from '../lib/router'
import { dmThreadId, keyring, msgApi, seal, sendEnvelope, type DirectoryEntry, type Identity } from '../lib/messaging'
import { Modal } from './Modal'

/** From the PSBT screen: notify trustees over the encrypted channel and link the PSBT for them to sign. */
export function RequestSignature({ wallet, psbt, onClose, onSent }: { wallet: Wallet; psbt: PsbtInfo; onClose: () => void; onSent?: (requestId: string) => void }) {
  const [dir, setDir] = useState<DirectoryEntry[] | null>(null)
  const [from, setFrom] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const actingFp = keyring.acting(wallet.id) ?? keyring.all(wallet.id)[0]?.fingerprint
  const me = actingFp ? keyring.get(wallet.id, actingFp) : undefined

  useEffect(() => {
    msgApi.directory(wallet.id).then((d) => {
      setDir(d)
      setFrom(d.filter((x) => x.identity && x.fingerprint !== me?.fingerprint && !psbt.signedBy.includes(x.fingerprint)).map((x) => x.fingerprint))
    }).catch((e) => setError(e.message))
  }, [wallet.id, me?.fingerprint, psbt.signedBy])

  const registered = me && dir?.find((d) => d.fingerprint === me.fingerprint)?.identity?.signPub === me.signPub
  const members = (dir ?? []).filter((d) => d.identity).map((d) => d.identity!) as Identity[]
  const threadId = from.length === 1 && me ? dmThreadId(me.fingerprint, from[0]) : 'group'
  const spend = psbt.outputs.filter((o) => !o.isChange)
  const summary = spend.map((o) => `${btc(o.amount, 8)} BTC → ${o.address.slice(0, 14)}…`).join(', ')

  const send = async () => {
    if (!me) return
    setBusy(true); setError(null)
    try {
      const req = await msgApi.createSigRequest(wallet.id, me, { psbt: psbt.psbt, threadId, requestedFrom: from, urgent })
      const recipients = threadId === 'group' ? members : members.filter((m) => threadId.includes(m.fingerprint))
      await sendEnvelope(wallet.id, me, seal(wallet.id, me, threadId, recipients, { type: 'sigreq', requestId: req.id, txid: req.txid, summary, text: note.trim() || undefined }, urgent))
      setDone(threadId); onSent?.(req.id)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Request signature" onClose={onClose}>
      {!dir ? <div className="muted">Loading trustees…</div> : !registered ? (
        <div className="form">
          <p className="hint">You need a verified trustee identity on this device to send encrypted requests.</p>
          <button className="btn primary" onClick={() => navigate(`/messages/${wallet.id}`)}>Set up trustee messaging</button>
        </div>
      ) : done ? (
        <div className="done" data-testid="sigreq-sent">
          <div className="done-check">✓</div>
          <h3>Request sent</h3>
          <p className="muted">Trustees were notified over the encrypted channel{urgent ? ' with an urgent alert' : ''}. Status updates in the thread as they sign.</p>
          <button className="btn primary" onClick={() => navigate(`/messages/${wallet.id}?thread=${encodeURIComponent(done)}`)}>Open thread</button>
        </div>
      ) : (
        <div className="form">
          <div className="review-row"><span className="muted">Transaction</span><strong>{summary}</strong></div>
          <div className="review-row"><span className="muted">Signatures</span><strong>{psbt.signatures}/{psbt.required}</strong></div>
          <span className="field-label">Ask</span>
          <div className="pick-list">
            {dir.filter((d) => d.fingerprint !== me!.fingerprint).map((d) => (
              <label key={d.fingerprint} className={`check pick ${!d.identity ? 'disabled' : ''}`}>
                <input type="checkbox" disabled={!d.identity || psbt.signedBy.includes(d.fingerprint)} checked={from.includes(d.fingerprint)}
                  onChange={(e) => setFrom((f) => e.target.checked ? [...f, d.fingerprint] : f.filter((x) => x !== d.fingerprint))} />
                {d.label} <span className="muted small">{psbt.signedBy.includes(d.fingerprint) ? 'already signed' : d.identity ? '✓ verified' : 'not enrolled'}</span>
              </label>
            ))}
          </div>
          <label>Note (encrypted)<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Quarterly distribution to Avery per section 4" /></label>
          <label className="check urgent-toggle"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />🚨 Urgent: escalate with a banner for every trustee</label>
          <p className="hint">Sent as {dir.find((d) => d.fingerprint === me!.fingerprint)?.label} to {threadId === 'group' ? 'the all-trustees thread' : 'a direct thread'}.</p>
          <button className="btn primary" disabled={busy || from.length === 0} onClick={send} data-testid="sigreq-send">{busy ? 'Encrypting…' : '✉ Send request'}</button>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  )
}
