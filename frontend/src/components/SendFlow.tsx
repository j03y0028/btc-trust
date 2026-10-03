import { useState } from 'react'
import { btc, walletApi, type PsbtInfo, type WalletDetail } from '../lib/api'
import { SigRing } from './SigRing'

export function SendFlow({ wallet, onDone }: { wallet: WalletDetail; onDone: () => void }) {
  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [feeRate, setFeeRate] = useState('2')
  const [psbt, setPsbt] = useState<PsbtInfo | null>(null)
  const [imported, setImported] = useState('')
  const [txid, setTxid] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const step = txid ? 2 : psbt ? 1 : 0

  return (
    <div className="send">
      <ol className="steps">
        {['Compose', 'Sign', 'Broadcast'].map((s, i) => (
          <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}><span>{i < step ? '✓' : i + 1}</span>{s}</li>
        ))}
      </ol>

      {step === 0 && (
        <form className="form" onSubmit={(e) => {
          e.preventDefault()
          run('create', async () => setPsbt(await walletApi.createPsbt(wallet.id, [{ address: address.trim(), amount: Number(amount) }], Number(feeRate) || undefined)))
        }}>
          <label>Recipient address<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="bcrt1…" spellCheck={false} required /></label>
          <div className="row2">
            <label>Amount (BTC)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" required /></label>
            <label>Fee rate (sat/vB)<input value={feeRate} onChange={(e) => setFeeRate(e.target.value)} inputMode="decimal" /></label>
          </div>
          <p className="hint">Available: {btc(wallet.balance.confirmed)} BTC confirmed</p>
          <div className="wizard-actions"><span />
            <button className="btn primary" disabled={!!busy}>{busy ? 'Building PSBT…' : 'Create PSBT'}</button>
          </div>
        </form>
      )}

      {step === 1 && psbt && (
        <div className="sign-step">
          <div className="sign-top">
            <SigRing have={psbt.signatures} need={psbt.required} />
            <div className="tx-summary">
              {psbt.outputs.map((o, i) => (
                <div key={i} className={`out ${o.isChange ? 'change' : ''}`}>
                  <span>{o.isChange ? 'Change' : 'To'}</span>
                  <code title={o.address}>{o.address.slice(0, 14)}…{o.address.slice(-8)}</code>
                  <strong>{btc(o.amount)} BTC</strong>
                </div>
              ))}
              <div className="out fee"><span>Network fee</span><code>{psbt.inputs} input{psbt.inputs > 1 ? 's' : ''}</code><strong>{psbt.fee !== null ? btc(psbt.fee) : '?'} BTC</strong></div>
            </div>
          </div>

          <ul className="cosigners">
            {wallet.cosigners.map((c, i) => {
              const signed = psbt.signedBy.includes(c.fingerprint)
              return (
                <li key={c.fingerprint + i} className={`cosigner ${signed ? 'signed' : ''}`} data-testid={`cosigner-${i}`}>
                  <span className="avatar">{signed ? '✓' : c.label.slice(0, 1).toUpperCase()}</span>
                  <div className="cos-body"><strong>{c.label}</strong><code>{c.fingerprint}</code></div>
                  {signed ? <span className="badge badge-complete">Signed</span>
                    : !c.local ? <span className="badge badge-planned">External</span>
                    : <button className="btn small" disabled={!!busy || psbt.complete} onClick={() => run(`sign${i}`, async () => setPsbt(await walletApi.sign(wallet.id, psbt.psbt, i)))}>
                        {busy === `sign${i}` ? 'Signing…' : 'Sign'}
                      </button>}
                </li>
              )
            })}
          </ul>

          <details className="psbt-box">
            <summary>PSBT · export / import for external signers</summary>
            <div className="psbt-actions">
              <button className="btn small ghost" onClick={() => { navigator.clipboard?.writeText(psbt.psbt); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
                {copied ? 'Copied ✓' : 'Copy PSBT'}
              </button>
            </div>
            <textarea rows={3} value={imported} onChange={(e) => setImported(e.target.value)} placeholder="Paste a PSBT signed elsewhere to combine…" spellCheck={false} />
            <button className="btn small" disabled={!imported.trim() || !!busy}
              onClick={() => run('combine', async () => { setPsbt(await walletApi.combine(wallet.id, [psbt.psbt, imported.trim()])); setImported('') })}>Combine</button>
          </details>

          <div className="wizard-actions">
            <button className="btn ghost" onClick={() => setPsbt(null)}>Discard</button>
            <button className="btn primary" disabled={!psbt.complete || !!busy}
              onClick={() => run('broadcast', async () => setTxid((await walletApi.broadcast(wallet.id, psbt.psbt)).txid))}>
              {psbt.complete ? (busy === 'broadcast' ? 'Broadcasting…' : 'Finalize & broadcast') : `Needs ${psbt.required - psbt.signatures} more signature${psbt.required - psbt.signatures > 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}

      {step === 2 && txid && (
        <div className="done">
          <div className="done-check">✓</div>
          <h3>Transaction broadcast</h3>
          <code className="txid">{txid}</code>
          <p className="hint">Mine a block on regtest to confirm it.</p>
          <div className="wizard-actions"><span /><button className="btn primary" onClick={onDone}>Done</button></div>
        </div>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  )
}
