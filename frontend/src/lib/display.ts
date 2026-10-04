// Display preferences (BTC / sats, fiat currency) and live BTC prices, shared by every amount on screen.
// The choice is saved server-side (/api/settings/display, per app login) and cached in localStorage for instant start.
import { useEffect, useSyncExternalStore } from 'react'
import type { BtcUnit } from './money'
import { CURRENCIES as SHARED } from '../../../shared/currencies'

export interface DisplayPrefs { unit: BtcUnit; fiat: string | null }
export const DEFAULT_DISPLAY: DisplayPrefs = { unit: 'BTC', fiat: 'USD' }
export interface Currency { code: string; name: string }

/** Same list the backend price feed supports (shared/currencies.ts). */
export const CURRENCIES: Currency[] = SHARED.map(([code, name]) => ({ code, name }))
const CODES = new Set(CURRENCIES.map((c) => c.code))

export type Price =
  | { available: true; currency: string; price: string; priceE8: string; source: string; fetchedAt: number; sourceTime?: number; stale: boolean }
  | { available: false; currency: string; disabled?: boolean; error: string }

export const TEST_NOTE = 'Test bitcoin has no real value. The amount is converted at the live mainnet price for illustration only.'

const LS_KEY = 'btctrust.display'
export const PRICE_REFRESH_MS = 60_000

const valid = (p: unknown): p is DisplayPrefs => {
  const o = p as DisplayPrefs
  return !!o && typeof o === 'object' && (o.unit === 'BTC' || o.unit === 'sats') && (o.fiat === null || CODES.has(o.fiat as string))
}
const readLocal = (): DisplayPrefs | null => {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); return valid(v) ? v : null } catch { return null }
}
const writeLocal = (p: DisplayPrefs) => { try { localStorage.setItem(LS_KEY, JSON.stringify(p)) } catch { /* private mode */ } }

let prefs: DisplayPrefs = readLocal() ?? DEFAULT_DISPLAY
let serverLoaded = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

function loadServerPrefs() {
  if (serverLoaded) return
  serverLoaded = true
  fetch('/api/settings/display').then((r) => (r.ok ? r.json() : null)).then((p) => {
    if (valid(p) && (p.unit !== prefs.unit || p.fiat !== prefs.fiat)) { prefs = p; writeLocal(p); emit() }
  }).catch(() => { /* keep local choice */ })
}

export function useDisplay(): DisplayPrefs {
  useEffect(loadServerPrefs, [])
  return useSyncExternalStore(subscribe, () => prefs)
}

/** Change the display; applied instantly, then saved server-side. Throws if the server refuses. */
export async function setDisplay(patch: Partial<DisplayPrefs>): Promise<void> {
  prefs = { ...prefs, ...patch }
  writeLocal(prefs)
  emit()
  const r = await fetch('/api/settings/display', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!r.ok) {
    const b = await r.json().catch(() => ({}))
    throw new Error(b.error ?? `HTTP ${r.status}`)
  }
}

// ---- prices: one request per currency per minute, shared by all amounts ----
interface PriceSlot { value: Price | null; at: number; pending: boolean; users: number; timer?: ReturnType<typeof setInterval> }
const prices = new Map<string, PriceSlot>()
let priceVersion = 0
const priceListeners = new Set<() => void>()
const priceSubscribe = (l: () => void) => { priceListeners.add(l); return () => { priceListeners.delete(l) } }

const validPrice = (p: unknown, currency: string): p is Price => {
  const o = p as Record<string, unknown>
  if (!o || typeof o !== 'object' || o.currency !== currency) return false
  if (o.available === true) return typeof o.priceE8 === 'string' && /^[1-9]\d*$/.test(o.priceE8) && typeof o.source === 'string' && typeof o.fetchedAt === 'number'
  return o.available === false && typeof o.error === 'string'
}

async function refreshPrice(currency: string) {
  const slot = prices.get(currency)
  if (!slot || slot.pending) return
  slot.pending = true
  try {
    const r = await fetch(`/api/prices?currency=${encodeURIComponent(currency)}`)
    const body = await r.json().catch(() => null)
    slot.value = validPrice(body, currency) ? body : { available: false, currency, error: (body as { error?: string })?.error ?? `Price unavailable (HTTP ${r.status})` }
  } catch (e) {
    slot.value = { available: false, currency, error: `Price unavailable: ${(e as Error).message}` }
  } finally {
    slot.pending = false; slot.at = Date.now(); priceVersion++; priceListeners.forEach((l) => l())
  }
}

/** Live price for `currency` (null while loading or when no fiat is chosen). Refreshes every minute while shown. */
export function usePrice(currency: string | null): Price | null {
  useEffect(() => {
    if (!currency) return
    let slot = prices.get(currency)
    if (!slot) { slot = { value: null, at: 0, pending: false, users: 0 }; prices.set(currency, slot) }
    slot.users++
    if (Date.now() - slot.at >= PRICE_REFRESH_MS) refreshPrice(currency)
    if (!slot.timer) slot.timer = setInterval(() => refreshPrice(currency), PRICE_REFRESH_MS)
    return () => {
      const s = prices.get(currency)
      if (s && --s.users === 0 && s.timer) { clearInterval(s.timer); s.timer = undefined }
    }
  }, [currency])
  useSyncExternalStore(priceSubscribe, () => priceVersion)
  return currency ? prices.get(currency)?.value ?? null : null
}

/** Tests only: forget cached prices and preferences. */
export function __resetDisplay() {
  for (const s of prices.values()) if (s.timer) clearInterval(s.timer)
  prices.clear(); priceVersion++
  prefs = readLocal() ?? DEFAULT_DISPLAY
  serverLoaded = false
  emit()
}

export const priceTime = (p: Extract<Price, { available: true }>) =>
  new Date(p.sourceTime ?? p.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
