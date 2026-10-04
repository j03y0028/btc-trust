import { useMemo, useState } from 'react'
import { Modal } from './Modal'
import { CURRENCIES, TEST_NOTE, setDisplay, useDisplay, usePrice, priceTime } from '../lib/display'
import { formatBtc, formatFiat, formatSats } from '../lib/money'

const symbol = (code: string) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? code } catch { return code }
}

export function CurrencyPicker({ onClose, network, sampleSats = 100_000_000n }: { onClose: () => void; network?: string | null; sampleSats?: bigint }) {
  const prefs = useDisplay()
  const price = usePrice(prefs.fiat)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const test = !!network && network !== 'main'
  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? CURRENCIES.filter((c) => c.code.toLowerCase().includes(t) || c.name.toLowerCase().includes(t)) : CURRENCIES
  }, [q])
  const save = (patch: Parameters<typeof setDisplay>[0], close = false) => {
    setError(null)
    setDisplay(patch).catch((e) => setError(`Shown here, but not saved on the node: ${(e as Error).message}`))
    if (close) onClose()
  }

  return (
    <Modal title="Display currency" onClose={onClose}>
      <div className="cp">
        <div className="cp-label">Bitcoin unit</div>
        <div className="cp-seg" role="radiogroup" aria-label="Bitcoin unit">
          {(['BTC', 'sats'] as const).map((u) => (
            <button key={u} type="button" role="radio" aria-checked={prefs.unit === u} className={`cp-seg-btn ${prefs.unit === u ? 'on' : ''}`} onClick={() => save({ unit: u })}>
              <strong>{u === 'BTC' ? '₿ BTC' : 'sats'}</strong>
              <small>{u === 'BTC' ? `${formatBtc(sampleSats)} BTC` : `${formatSats(sampleSats)} sats`}</small>
            </button>
          ))}
        </div>

        <div className="cp-label">Show value in</div>
        <input className="cp-search" placeholder="Search currencies…" aria-label="Search currencies" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="cp-grid" role="listbox" aria-label="Currencies">
          {list.map((c) => (
            <button key={c.code} type="button" role="option" aria-selected={prefs.fiat === c.code} className={`cp-cur ${prefs.fiat === c.code ? 'on' : ''}`}
              onClick={() => save({ fiat: c.code }, true)} data-testid={`cur-${c.code}`}>
              <span className="cp-sym">{symbol(c.code)}</span>
              <span className="cp-code">{c.code}</span>
              <span className="cp-name">{c.name}</span>
            </button>
          ))}
          {list.length === 0 && <p className="muted small">No currency matches “{q}”.</p>}
        </div>
        <button type="button" className={`cp-none ${prefs.fiat === null ? 'on' : ''}`} role="option" aria-selected={prefs.fiat === null} onClick={() => save({ fiat: null }, true)}>
          Bitcoin only: hide the fiat value
        </button>

        {error && <div className="cp-error" role="alert">{error}</div>}

        <div className="cp-foot">
          {prefs.fiat && price?.available && (
            <div className="cp-price" data-testid="cp-price">
              <strong>1 BTC ≈ {formatFiat(100_000_000n, BigInt(price.priceE8), price.currency)}</strong>
              <span className="muted"> · {price.source} · updated {priceTime(price)}{price.stale ? ' (last known price, sources unreachable)' : ''}</span>
            </div>
          )}
          {prefs.fiat && price && !price.available && <div className="cp-price unavailable" data-testid="cp-price">⚠ {price.disabled ? 'The price feed is switched off on this node.' : 'Price unavailable right now. Amounts are still shown in bitcoin.'} <span className="muted small">{price.error}</span></div>}
          {test && <p className="cp-note test">🧪 {TEST_NOTE}</p>}
          <p className="cp-note muted">Your node fetches the price from public sources (mempool.space, with Coinbase, Kraken and others as fallbacks) about once a minute. Your browser never contacts them, and no addresses or amounts are sent.</p>
        </div>
      </div>
    </Modal>
  )
}
