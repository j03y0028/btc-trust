import { useState } from 'react'
import { walletApi, type Wallet, type WalletType } from '../lib/api'

type Choice = 'multisig' | 'custom' | 'singlesig' | 'watchonly'
const CHOICES: { id: Choice; title: string; tag?: string; desc: string; icon: string }[] = [
  { id: 'multisig', title: '2-of-3 Multisig', tag: 'Recommended', icon: '⛬', desc: 'Three keys, any two can spend. Survives one lost or stolen key.' },
  { id: 'custom', title: 'Custom m-of-n', icon: '⌗', desc: 'Pick your own quorum, from 1-of-1 up to 15-of-15.' },
  { id: 'singlesig', title: 'Single-sig', icon: '◉', desc: 'One key (wpkh). Simple hot wallet for small amounts.' },
  { id: 'watchonly', title: 'Watch-only', icon: '◎', desc: 'Import an xpub or descriptor. Track funds without keys.' },
]
const LETTERS = 'ABCDEFGHIJKLMNO'

export function CreateWalletWizard({ onCreated, onCancel }: { onCreated: (w: Wallet) => void; onCancel: () => void }) {
  const [step, setStep] = useState(0)
  const [choice, setChoice] = useState<Choice>('multisig')
  const [name, setName] = useState('Family Trust Vault')
  const [m, setM] = useState(2)
  const [n, setN] = useState(3)
  const [labels, setLabels] = useState<string[]>(['Jordan', 'Trustee', 'Backup'])
  const [importText, setImportText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const type: WalletType = choice === 'custom' ? 'multisig' : choice
  const effM = choice === 'multisig' ? 2 : choice === 'custom' ? m : 1
  const effN = choice === 'multisig' ? 3 : choice === 'custom' ? n : 1
  const isDescriptor = /^\s*[a-z]+\(/.test(importText)

  const setNClamped = (v: number) => { setN(v); if (m > v) setM(v) }

  async function create() {
    setBusy(true); setError(null)
    try {
      const w = await walletApi.create({
        name, type,
        ...(type === 'multisig' ? { m: effM, n: effN, cosignerLabels: labels.slice(0, effN) } : {}),
        ...(type === 'singlesig' ? { cosignerLabels: [labels[0]] } : {}),
        ...(type === 'watchonly' ? (isDescriptor ? { descriptor: importText.trim() } : { xpub: importText.trim() }) : {}),
      })
      onCreated(w)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canNext = step === 0 || (name.trim().length > 0 && (type !== 'watchonly' || importText.trim().length > 20))

  return (
    <div className="wizard">
      <ol className="steps">
        {['Type', 'Configure', 'Review'].map((s, i) => (
          <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}><span>{i < step ? '✓' : i + 1}</span>{s}</li>
        ))}
      </ol>

      {step === 0 && (
        <div className="type-grid" role="radiogroup" aria-label="Wallet type">
          {CHOICES.map((c) => (
            <button key={c.id} role="radio" aria-checked={choice === c.id} className={`type-card ${choice === c.id ? 'selected' : ''}`}
              onClick={() => setChoice(c.id)} data-testid={`type-${c.id}`}>
              <span className="type-icon">{c.icon}</span>
              <span className="type-title">{c.title}{c.tag && <em>{c.tag}</em>}</span>
              <span className="type-desc">{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      {step === 1 && (
        <div className="form">
          <label>Wallet name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} /></label>
          {choice === 'custom' && (
            <div className="mn">
              <label>Required signatures (m): <strong>{m}</strong>
                <input type="range" min={1} max={n} value={m} onChange={(e) => setM(+e.target.value)} aria-label="m" />
              </label>
              <label>Total keys (n): <strong>{n}</strong>
                <input type="range" min={1} max={15} value={n} onChange={(e) => setNClamped(+e.target.value)} aria-label="n" />
              </label>
            </div>
          )}
          {type === 'multisig' && (
            <div className="labels">
              <span className="field-label">Cosigner labels</span>
              <div className="label-grid">
                {Array.from({ length: effN }, (_, i) => (
                  <input key={i} placeholder={`Cosigner ${LETTERS[i]}`} value={labels[i] ?? ''}
                    onChange={(e) => setLabels((l) => { const c = [...l]; c[i] = e.target.value; return c })} />
                ))}
              </div>
              <p className="hint">Each cosigner key is generated in its own bitcoind regtest wallet. Only xpubs leave bitcoind.</p>
            </div>
          )}
          {type === 'watchonly' && (
            <label>xpub / tpub or output descriptor
              <textarea rows={4} value={importText} onChange={(e) => setImportText(e.target.value)}
                placeholder="[fingerprint/84h/1h/0h]tpub…  or  wsh(sortedmulti(2,…))" spellCheck={false} />
              <span className="hint">{importText ? (isDescriptor ? 'Detected: descriptor' : 'Detected: extended public key → wpkh') : 'Public keys only, never paste private keys.'}</span>
            </label>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="review">
          <div className="review-row"><span>Name</span><strong>{name}</strong></div>
          <div className="review-row"><span>Type</span><strong>{type === 'multisig' ? `${effM}-of-${effN} multisig · P2WSH (wsh(sortedmulti))` : type === 'singlesig' ? 'Single-sig · P2WPKH' : 'Watch-only import'}</strong></div>
          {type === 'multisig' && <div className="review-row"><span>Cosigners</span><strong>{Array.from({ length: effN }, (_, i) => labels[i] || `Cosigner ${LETTERS[i]}`).join(' · ')}</strong></div>}
          <div className="review-row"><span>Network</span><strong className="net-chip">regtest</strong></div>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      )}

      <div className="wizard-actions">
        <button className="btn ghost" onClick={step === 0 ? onCancel : () => setStep(step - 1)}>{step === 0 ? 'Cancel' : 'Back'}</button>
        {step < 2
          ? <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue</button>
          : <button className="btn primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create wallet'}</button>}
      </div>
    </div>
  )
}
