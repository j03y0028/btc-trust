// Exact BTC / sats / fiat math. Everything runs on integer sats (BigInt), never on float BTC × price.

export type BtcUnit = 'BTC' | 'sats'
export const SATS_PER_BTC = 100_000_000n

/** bitcoind amounts are 8-decimal BTC numbers; ×1e8 and round recovers the exact integer sats. */
export function toSats(btc: number | bigint): bigint {
  if (typeof btc === 'bigint') return btc
  if (!Number.isFinite(btc)) return 0n
  return BigInt(Math.round(btc * 1e8))
}

/** Digits a currency is normally shown with (JPY/KRW 0, most 2). */
export function fiatDigits(currency: string): number {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 } catch { return 2 }
}

/** sats × (price × 1e8) → fiat minor units (cents, yen…), rounded half away from zero. */
export function satsToFiatMinor(sats: bigint, priceE8: bigint, digits: number): bigint {
  const num = sats * priceE8 * 10n ** BigInt(digits)
  const den = SATS_PER_BTC * SATS_PER_BTC
  const neg = num < 0n
  const a = neg ? -num : num
  const q = (a * 2n + den) / (2n * den)
  return neg ? -q : q
}

/** Exact decimal string for an integer scaled by 10^digits: (123456n, 2) → "1234.56". */
function decimal(minor: bigint, digits: number): string {
  const neg = minor < 0n
  const a = (neg ? -minor : minor).toString().padStart(digits + 1, '0')
  const s = digits ? `${a.slice(0, -digits)}.${a.slice(-digits)}` : a
  return neg ? `-${s}` : s
}

const nfCache = new Map<string, Intl.NumberFormat>()
const nf = (currency: string, digits: number) => {
  const k = `${currency}:${digits}`
  let f = nfCache.get(k)
  if (!f) { f = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }); nfCache.set(k, f) }
  return f
}

/** Format fiat minor units, e.g. (123456n, 'USD') → "$1,234.56", (1234n, 'JPY') → "¥1,234". */
export function formatFiatMinor(minor: bigint, currency: string, digits = fiatDigits(currency)): string {
  // Intl accepts exact decimal strings (no float rounding of large values)
  return nf(currency, digits).format(decimal(minor, digits) as unknown as number)
}

/** Fiat value of an amount; tiny non-zero amounts read "< $0.01" instead of a misleading "$0.00". */
export function formatFiat(sats: bigint, priceE8: bigint, currency: string): string {
  const digits = fiatDigits(currency)
  const minor = satsToFiatMinor(sats, priceE8, digits)
  if (minor === 0n && sats !== 0n) return `${sats < 0n ? '-' : ''}< ${formatFiatMinor(1n, currency, digits)}`
  return formatFiatMinor(minor, currency, digits)
}

/** BTC from integer sats: at least 2 and at most `max` decimals, grouped ("1,234.5"). */
export function formatBtc(sats: bigint, max = 8): string {
  const neg = sats < 0n
  const a = neg ? -sats : sats
  const whole = (a / SATS_PER_BTC).toLocaleString('en-US')
  let frac = (a % SATS_PER_BTC).toString().padStart(8, '0')
  // round to `max` decimals (half up), carrying into the whole part
  if (max < 8) {
    const keep = 10n ** BigInt(8 - max)
    const r = ((a % SATS_PER_BTC) + keep / 2n) / keep
    if (r >= 10n ** BigInt(max)) return formatBtc((neg ? -1n : 1n) * ((a / SATS_PER_BTC + 1n) * SATS_PER_BTC), max)
    frac = r.toString().padStart(max, '0')
  }
  frac = frac.replace(/0+$/, '')
  if (frac.length < 2) frac = frac.padEnd(2, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

export const formatSats = (sats: bigint) => sats.toLocaleString('en-US')

/** Amount in the chosen bitcoin unit, without the unit label. */
export const formatUnit = (sats: bigint, unit: BtcUnit, maxBtcDigits = 8) => (unit === 'sats' ? formatSats(sats) : formatBtc(sats, maxBtcDigits))
