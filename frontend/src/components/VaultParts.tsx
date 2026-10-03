import type { Wallet } from '../lib/api'

const MIN_PASS = 10

export function strength(p: string) {
  let s = 0
  if (p.length >= MIN_PASS) s++
  if (p.length >= 16) s++
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++
  if (/\d/.test(p) || /[^A-Za-z0-9]/.test(p)) s++
  if (p.split(/\s+/).filter(Boolean).length >= 4) s++
  return Math.min(4, s)
}
export function StrengthMeter({ value }: { value: string }) {
  const s = value ? strength(value) : 0
  return <div className={`strength s${s}`} aria-label={`Passphrase strength ${s} of 4`}><i /><i /><i /><i /><span>{['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s]}</span></div>
}

export function SecondFactorPicker({ wallet, value, onChange }: { wallet: Wallet; value: { cosigner: number; address?: string } | null; onChange: (v: { cosigner: number; address?: string } | null) => void }) {
  const c = value ? wallet.cosigners[value.cosigner] : undefined
  return (
    <div className="sf-picker">
      <label className="check"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { cosigner: 0 } : null)} data-testid="sf-toggle" /> Also require a wallet signature to unlock</label>
      {value && (
        <>
          <div className="seg">
            {wallet.cosigners.map((x, i) => (
              <button type="button" key={i} className={value.cosigner === i ? 'active' : ''} onClick={() => onChange({ cosigner: i })}>{x.label} <span className="muted small">{x.fingerprint}</span></button>
            ))}
          </div>
          {c?.kind === 'airgapped' && <input placeholder="P2PKH address (m… / n…) your offline wallet can sign with" value={value.address ?? ''} onChange={(e) => onChange({ ...value, address: e.target.value })} />}
          <p className="hint">{c?.kind === 'hardware' ? 'The device signs a challenge with its BIP44 identity key m/44h/1h/0h/0/0.' : c?.kind === 'airgapped' ? 'You will paste a signmessage signature produced offline.' : 'The node signs with this cosigner\u2019s identity key; any signmessage-compatible wallet works.'}</p>
        </>
      )}
    </div>
  )
}

