import { useState } from 'react'
import { TEST_NOTE, useDisplay, usePrice, priceTime } from '../lib/display'
import { formatFiat, formatUnit, toSats } from '../lib/money'
import { CurrencyPicker } from './CurrencyPicker'

const isTestNet = (network?: string | null) => !!network && network !== 'main' && network !== 'mainnet'

/**
 * A bitcoin amount in the chosen unit (BTC / sats) with its fiat value underneath.
 * `interactive` amounts open the currency picker when clicked; inside other buttons (wallet cards) use interactive={false}.
 */
export function Amount({ btc, network, variant = 'inline', interactive = true, digits = 8, signed = false, meta = false, testId }: {
  btc: number; network?: string | null; variant?: 'hero' | 'title' | 'card' | 'inline'; interactive?: boolean
  digits?: number; signed?: boolean; meta?: boolean; testId?: string
}) {
  const prefs = useDisplay()
  const price = usePrice(prefs.fiat)
  const [open, setOpen] = useState(false)
  const sats = toSats(btc)
  const sign = signed && sats > 0n ? '+' : ''
  const unitLabel = prefs.unit === 'sats' ? 'sats' : 'BTC'
  const test = isTestNet(network)
  const content = (
    <>
      <span className="amt-num" data-testid={testId}>{sign}{formatUnit(sats, prefs.unit, digits)} <small>{unitLabel}</small></span>
      {interactive && <span className="amt-caret" aria-hidden><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg></span>}
    </>
  )

  let fiat = null
  if (prefs.fiat) {
    if (!price) fiat = <span className="amt-fiat amt-loading" aria-label="Loading price"><i /></span>
    else if (!price.available) fiat = <span className="amt-fiat amt-unavailable" title={price.error} data-testid="fiat-unavailable">{price.disabled ? 'Price feed off' : 'Price unavailable'}</span>
    else {
      const value = formatFiat(sats, BigInt(price.priceE8), price.currency)
      const per = formatFiat(100_000_000n, BigInt(price.priceE8), price.currency)
      fiat = (
        <span className={`amt-fiat${price.stale ? ' amt-stale' : ''}`} title={`1 BTC = ${per} · ${price.source} · updated ${priceTime(price)}${price.stale ? ' (last known price)' : ''}${test ? `\n${TEST_NOTE}` : ''}`}>
          <span data-testid="fiat-value">≈ {sign}{value}</span>
          {test && variant !== 'inline' && <em className="amt-test" title={TEST_NOTE}>test coins · illustrative</em>}
          {meta && <span className="amt-meta">{price.source} · {priceTime(price)}{price.stale ? ' · last known' : ''}</span>}
        </span>
      )
    }
  }

  return (
    <span className={`amt amt-${variant}`}>
      {interactive
        ? <button type="button" className="amt-main" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Change display currency">{content}</button>
        : <span className="amt-main">{content}</span>}
      {fiat}
      {open && <CurrencyPicker onClose={() => setOpen(false)} network={network} sampleSats={sats} />}
    </span>
  )
}
