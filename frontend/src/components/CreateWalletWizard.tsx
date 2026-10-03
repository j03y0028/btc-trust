import { useEffect, useState } from 'react'
import { deviceApi, deviceName, walletApi, type CreateWalletInput, type HwDevice, type SignerKind, type Wallet, type WalletType } from '../lib/api'
import { KindBadge } from './KindBadge'

type Choice = 'multisig' | 'custom' | 'singlesig' | 'watchonly'
const CHOICES: { id: Choice; title: string; tag?: string; desc: string; icon: string }[] = [
  { id: 'multisig', title: '2-of-3 Multisig', tag: 'Recommended', icon: '⛬', desc: 'Three keys, any two can spend. Survives one lost or stolen key.' },
  { id: 'custom', title: 'Custom m-of-n', icon: '⌗', desc: 'Pick your own quorum, from 1-of-1 up to 15-of-15.' },
  { id: 'singlesig', title: 'Single-sig', icon: '◉', desc: 'One key (wpkh), either a hot key or a hardware wallet.' },
  { id: 'watchonly', title: 'Watch-only', icon: '◎', desc: 'Import an xpub or descriptor. Track funds without keys.' },
]
const LETTERS = 'ABCDEFGHIJKLMNO'
interface Slot { kind: SignerKind; fp?: string; key?: string }
export interface WizardPreset { choice?: 'multisig' | 'singlesig'; hw?: string }

export function CreateWalletWizard({ onCreated, onCancel, preset }: { onCreated: (w: Wallet) => void; onCancel: () => void; preset?: WizardPreset }) {
  const [step, setStep] = useState(preset?.hw ? 1 : 0)
  const [choice, setChoice] = useState<Choice>(preset?.choice ?? 'multisig')
  const [name, setName] = useState(preset?.choice === 'singlesig' ? 'Hardware Wallet' : 'Family Trust Vault')
  const [m, setM] = useState(2)
  const [n, setN] = useState(3)
  const [labels, setLabels] = useState<string[]>(preset?.hw ? ['Trezor', 'Jordan', 'Backup'] : ['Jordan', 'Trustee', 'Backup'])
  const [slots, setSlots] = useState<Slot[]>(() => Array.from({ length: 15 }, (_, i) => (i === 0 && preset?.hw ? { kind: 'hardware', fp: preset.hw } : { kind: 'software' })))
  const [importText, setImportText] = useState('')
  const [devices, setDevices] = useState<HwDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    deviceApi.list().then((d) => setDevices(Array.isArray(d) ? d.filter((x) => x.fingerprint && !x.error) : [])).catch(() => {})
  }, [])

  const type: WalletType = choice === 'custom' ? 'multisig' : choice
  const effM = choice === 'multisig' ? 2 : choice === 'custom' ? m : 1
  const effN = choice === 'multisig' ? 3 : choice === 'custom' ? n : 1
  const isDescriptor = /^\s*[a-z]+\(/.test(importText)
  const active = slots.slice(0, effN)
  const setSlot = (i: number, s: Partial<Slot>) => setSlots((all) => all.map((x, j) => (j === i ? { ...x, ...s } : x)))
  const setNClamped = (v: number) => { setN(v); if (m > v) setM(v) }
  const devName = (fp?: string) => { const d = devices.find((x) => x.fingerprint === fp); return d ? deviceName(d) : fp ?? '' }

  function payload(): CreateWalletInput {
    if (type === 'watchonly') return { name, type, ...(isDescriptor ? { descriptor: importText.trim() } : { xpub: importText.trim() }) }
    if (type === 'singlesig') {
      const s = slots[0]
      return { name, type, cosignerLabels: [labels[0]], ...(s.kind === 'hardware' && s.fp ? { hardware: [{ fingerprint: s.fp }] } : {}) }
    }
    // Backend order: hardware keys, then air-gapped keys, then generated software keys.
    const idx = active.map((s, i) => ({ s, i }))
    const hw = idx.filter((x) => x.s.kind === 'hardware' && x.s.fp)
    const ag = idx.filter((x) => x.s.kind === 'airgapped' && x.s.key?.trim())
    const sw = idx.filter((x) => !hw.includes(x) && !ag.includes(x))
    const lbl = (i: number) => labels[i] || `Cosigner ${LETTERS[i]}`
    return {
      name, type, m: effM, n: effN,
      cosignerLabels: [...hw, ...ag, ...sw].map((x) => lbl(x.i)),
      ...(hw.length ? { hardware: hw.map((x) => ({ fingerprint: x.s.fp!, label: lbl(x.i) })) } : {}),
      ...(ag.length ? { externalKeys: ag.map((x) => x.s.key!.trim()) } : {}),
    }
  }

  async function create() {
    setBusy(true); setError(null)
    try { onCreated(await walletApi.create(payload())) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const slotsValid = type === 'watchonly' || active.every((s) => (s.kind === 'hardware' ? !!s.fp : s.kind === 'airgapped' ? (s.key?.trim().length ?? 0) > 20 : true))
  const canNext = step === 0 || (name.trim().length > 0 && slotsValid && (type !== 'watchonly' || importText.trim().length > 20))

  const signerPicker = (i: number) => {
    const s = slots[i]
    const kinds: SignerKind[] = type === 'singlesig' ? ['software', 'hardware'] : ['software', 'hardware', 'airgapped']
    return (
      <div className="signer-picker">
        <div className="seg" role="radiogroup" aria-label={`Signer type ${i + 1}`}>
          {kinds.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={s.kind === k} className={s.kind === k ? 'on' : ''} data-testid={`slot-${i}-${k}`}
              onClick={() => setSlot(i, { kind: k, fp: k === 'hardware' ? (s.fp ?? devices[0]?.fingerprint ?? undefined) : undefined })}>
              {k === 'software' ? 'Software' : k === 'hardware' ? 'Hardware' : 'Air-gapped'}
            </button>
          ))}
        </div>
        {s.kind === 'hardware' && (
          devices.length
            ? <select value={s.fp ?? ''} onChange={(e) => setSlot(i, { fp: e.target.value })} aria-label={`Device ${i + 1}`}>
                {devices.map((d) => <option key={d.fingerprint} value={d.fingerprint!}>{deviceName(d)} · {d.fingerprint}</option>)}
              </select>
            : <span className="hint warn-text">No device detected. Connect one and reopen, or choose Air-gapped.</span>
        )}
        {s.kind === 'airgapped' && (
          <input value={s.key ?? ''} onChange={(e) => setSlot(i, { key: e.target.value })} placeholder="[fingerprint/48h/1h/0h/2h]tpub…" spellCheck={false} aria-label={`xpub ${i + 1}`} />
        )}
      </div>
    )
  }

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
              <span className="field-label">Cosigners · {effM} of {effN} required</span>
              <div className="slot-list">
                {Array.from({ length: effN }, (_, i) => (
                  <div key={i} className="slot">
                    <span className="slot-letter">{LETTERS[i]}</span>
                    <input className="slot-label" placeholder={`Cosigner ${LETTERS[i]}`} value={labels[i] ?? ''}
                      onChange={(e) => setLabels((l) => { const c = [...l]; c[i] = e.target.value; return c })} />
                    {signerPicker(i)}
                  </div>
                ))}
              </div>
              <p className="hint">Software keys are generated in their own bitcoind regtest wallets. Hardware keys use the device's BIP48 xpub. Only public keys are stored.</p>
            </div>
          )}
          {type === 'singlesig' && (
            <div className="labels">
              <span className="field-label">Key source</span>
              {signerPicker(0)}
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
          <div className="review-row"><span>Type</span><strong>{type === 'multisig' ? `${effM}-of-${effN} multisig · P2WSH (wsh(sortedmulti))` : type === 'singlesig' ? `Single-sig · P2WPKH${slots[0].kind === 'hardware' ? ' · hardware' : ''}` : 'Watch-only import'}</strong></div>
          {type === 'multisig' && (
            <div className="review-row"><span>Cosigners</span>
              <div className="review-cos">
                {active.map((s, i) => (
                  <span key={i}><KindBadge kind={s.kind} /> {labels[i] || `Cosigner ${LETTERS[i]}`}{s.kind === 'hardware' ? ` · ${devName(s.fp)}` : ''}</span>
                ))}
              </div>
            </div>
          )}
          <div className="review-row"><span>Network</span><strong className="net-chip">regtest</strong></div>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      )}

      <div className="wizard-actions">
        <button className="btn ghost" onClick={step === 0 ? onCancel : () => setStep(step - 1)}>{step === 0 ? 'Cancel' : 'Back'}</button>
        {step < 2
          ? <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue</button>
          : <button className="btn primary" disabled={busy} onClick={create}>{busy ? (active.some((s) => s.kind === 'hardware') ? 'Reading device xpub…' : 'Creating…') : 'Create wallet'}</button>}
      </div>
    </div>
  )
}
