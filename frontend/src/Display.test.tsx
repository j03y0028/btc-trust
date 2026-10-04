// BTC ↔ fiat display: exact integer math, per-currency formatting, the currency picker, persistence, unavailable state.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Amount } from './components/Amount'
import { Wallets } from './pages/Wallets'
import { CURRENCIES, __resetDisplay } from './lib/display'
import { fiatDigits, formatBtc, formatFiat, formatSats, satsToFiatMinor, toSats } from './lib/money'
import { CURRENCIES as SHARED } from '../../shared/currencies'

const PRICES: Record<string, string> = { USD: '84822', EUR: '75379', JPY: '13408005', MXN: '1540070.908345' }
const e8 = (p: string) => { const [w, f = ''] = p.split('.'); return (BigInt(w) * 100_000_000n + BigInt((f + '00000000').slice(0, 8))).toString() }
const priceBody = (c: string, over: object = {}) => ({ available: true, currency: c, price: PRICES[c], priceE8: e8(PRICES[c]), source: c === 'MXN' ? 'Coinbase' : 'mempool.space', fetchedAt: 1791081846688, sourceTime: 1791081603000, stale: false, ...over })

type Reply = { status?: number; body: unknown }
function mockApi(opts: { settings?: unknown; price?: (c: string) => unknown; put?: (body: unknown) => Reply; other?: (url: string) => unknown } = {}) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    let r: Reply
    if (url === '/api/settings/display' && init?.method === 'PUT') r = opts.put ? opts.put(JSON.parse(String(init.body))) : { body: { unit: 'BTC', fiat: 'USD', ...JSON.parse(String(init.body)) } }
    else if (url === '/api/settings/display') r = { body: opts.settings ?? { unit: 'BTC', fiat: 'USD' } }
    else if (url.startsWith('/api/prices?currency=')) { const c = url.split('=')[1]; r = { body: opts.price ? opts.price(c) : priceBody(c) } }
    else r = { body: opts.other ? opts.other(url) : {} }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const puts = (f: ReturnType<typeof mockApi>) => f.mock.calls.filter((c) => c[1]?.method === 'PUT').map((c) => JSON.parse(String(c[1]!.body)))
const priceCalls = (f: ReturnType<typeof mockApi>) => f.mock.calls.filter((c) => String(c[0]).startsWith('/api/prices')).map((c) => c[0])

beforeEach(() => { localStorage.clear(); __resetDisplay() })
afterEach(() => { vi.unstubAllGlobals(); __resetDisplay() })

describe('money math (integer sats, no float drift)', () => {
  it('converts float BTC from the API to exact sats', () => {
    expect(toSats(0.1 + 0.2)).toBe(30_000_000n)          // 0.30000000000000004
    expect(toSats(20999999.9769)).toBe(2_099_999_997_690_000n)
    expect(toSats(-0.00000001)).toBe(-1n)
  })
  it('sats × price is exact and rounds half away from zero', () => {
    expect(satsToFiatMinor(12_345_678n, 8_483_010_500_000n, 2)).toBe(1_047_285n)   // $10,472.85
    expect(satsToFiatMinor(150_000_000n, 1_340_800_500_000_000n, 0)).toBe(20_112_008n) // ¥20,112,007.5 → 20,112,008
    expect(satsToFiatMinor(-25_000_000n, 8_483_010_500_000n, 2)).toBe(-2_120_753n)  // -21,207.52625 → -21,207.53
    // 21 million BTC in yen: far beyond float precision, still exact
    expect(formatFiat(2_100_000_000_000_000n, BigInt(e8('13408005')), 'JPY')).toBe('¥281,568,105,000,000')
  })
  it('formats per currency: JPY/KRW without decimals, symbols, tiny amounts', () => {
    expect(fiatDigits('JPY')).toBe(0); expect(fiatDigits('KRW')).toBe(0); expect(fiatDigits('USD')).toBe(2)
    expect(formatFiat(100_000_000n, BigInt(e8('84822')), 'USD')).toBe('$84,822.00')
    expect(formatFiat(150_000_000n, BigInt(e8('75379')), 'EUR')).toBe('€113,068.50')
    expect(formatFiat(150_000_000n, BigInt(e8('13408005')), 'JPY')).toBe('¥20,112,008')
    expect(formatFiat(100_000_000n, BigInt(e8('1540070.908345')), 'MXN')).toBe('MX$1,540,070.91')
    expect(formatFiat(100_000_000n, BigInt(e8('120953.7')), 'CAD')).toBe('CA$120,953.70')
    expect(formatFiat(1n, BigInt(e8('84822')), 'USD')).toBe('< $0.01')
    expect(formatFiat(0n, BigInt(e8('84822')), 'USD')).toBe('$0.00')
  })
  it('formats BTC and sats from integers', () => {
    expect(formatBtc(150_000_000n)).toBe('1.50')
    expect(formatBtc(123_456_789n)).toBe('1.23456789')
    expect(formatBtc(199_999_999n, 4)).toBe('2.00')
    expect(formatBtc(-5_000n)).toBe('-0.00005')
    expect(formatBtc(2_100_000_000_000_000n, 4)).toBe('21,000,000.00')
    expect(formatSats(150_000_000n)).toBe('150,000,000')
  })
  it('the picker offers exactly the currencies the backend price feed supports (shared list)', () => {
    expect(CURRENCIES.map((c) => [c.code, c.name])).toEqual(SHARED.map(([c, n]) => [c, n]))
    expect(CURRENCIES.map((c) => c.code)).toEqual(expect.arrayContaining(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN']))
  })
})

describe('Amount + currency picker', () => {
  it('shows USD by default under the BTC amount, with source, time and a test-coin label on regtest', async () => {
    mockApi()
    render(<Amount btc={1.5} network="regtest" variant="hero" meta testId="balance" />)
    expect(screen.getByTestId('balance')).toHaveTextContent('1.50 BTC')
    expect(await screen.findByTestId('fiat-value')).toHaveTextContent('≈ $127,233.00')
    expect(screen.getByText('test coins · illustrative')).toHaveAttribute('title', expect.stringMatching(/no real value/))
    expect(screen.getByText(/mempool\.space · \d{1,2}:\d{2}/)).toBeInTheDocument()
  })
  it('no test label for a mainnet amount', async () => {
    mockApi()
    render(<Amount btc={1} network="main" variant="hero" />)
    await screen.findByTestId('fiat-value')
    expect(screen.queryByText('test coins · illustrative')).not.toBeInTheDocument()
  })
  it('clicking the amount opens the picker; choosing EUR converts, saves server-side and in localStorage', async () => {
    const f = mockApi()
    render(<Amount btc={1.5} network="regtest" variant="hero" />)
    await screen.findByTestId('fiat-value')
    fireEvent.click(screen.getByRole('button', { name: /1\.50 BTC/ }))
    const dlg = screen.getByRole('dialog', { name: 'Display currency' })
    expect(within(dlg).getByRole('option', { name: /USD/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(dlg).getByTestId('cp-price')).toHaveTextContent('1 BTC ≈ $84,822.00 · mempool.space')
    expect(within(dlg).getByText(/no real value/)).toBeInTheDocument()
    for (const c of ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN']) expect(within(dlg).getByTestId(`cur-${c}`)).toBeInTheDocument()
    fireEvent.click(within(dlg).getByTestId('cur-EUR'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('fiat-value')).toHaveTextContent('≈ €113,068.50'))
    expect(puts(f)).toEqual([{ fiat: 'EUR' }])
    expect(JSON.parse(localStorage.getItem('btctrust.display')!)).toEqual({ unit: 'BTC', fiat: 'EUR' })
  })
  it('JPY shows no decimals', async () => {
    mockApi({ settings: { unit: 'BTC', fiat: 'JPY' } })
    render(<Amount btc={1.5} variant="hero" />)
    await waitFor(() => expect(screen.getByTestId('fiat-value')).toHaveTextContent('≈ ¥20,112,008'))
  })
  it('switches to sats and back to BTC; can hide the fiat value', async () => {
    const f = mockApi()
    render(<Amount btc={1.5} variant="hero" testId="balance" />)
    await screen.findByTestId('fiat-value')
    fireEvent.click(screen.getByRole('button', { name: /BTC/ }))
    fireEvent.click(screen.getByRole('radio', { name: /sats/ }))
    expect(screen.getByTestId('balance')).toHaveTextContent('150,000,000 sats')
    expect(screen.getByRole('radio', { name: /sats/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: /BTC/ }))
    expect(screen.getByTestId('balance')).toHaveTextContent('1.50 BTC')
    fireEvent.click(screen.getByRole('option', { name: /Bitcoin only/ }))
    expect(screen.queryByTestId('fiat-value')).not.toBeInTheDocument()
    await waitFor(() => expect(puts(f)).toEqual([{ unit: 'sats' }, { unit: 'BTC' }, { fiat: null }]))
  })
  it('search filters currencies by code or name', async () => {
    mockApi()
    render(<Amount btc={1} />)
    fireEvent.click(screen.getByRole('button', { name: /BTC/ }))
    fireEvent.change(screen.getByLabelText('Search currencies'), { target: { value: 'peso' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['MX$MXNMexican Peso', 'Bitcoin only: hide the fiat value'])
  })
  it('the saved server choice wins over this browser; localStorage gives an instant start after reload', async () => {
    localStorage.setItem('btctrust.display', JSON.stringify({ unit: 'BTC', fiat: 'EUR' }))
    __resetDisplay()
    mockApi({ settings: { unit: 'sats', fiat: 'MXN' } })
    render(<Amount btc={1} variant="hero" testId="balance" />)
    await waitFor(() => expect(screen.getByTestId('balance')).toHaveTextContent('100,000,000 sats'))
    await waitFor(() => expect(screen.getByTestId('fiat-value')).toHaveTextContent('≈ MX$1,540,070.91'))
    expect(JSON.parse(localStorage.getItem('btctrust.display')!)).toEqual({ unit: 'sats', fiat: 'MXN' })
  })
  it('ignores invalid saved preferences', async () => {
    localStorage.setItem('btctrust.display', JSON.stringify({ unit: 'mBTC', fiat: 'XYZ' }))
    __resetDisplay()
    mockApi({ settings: { unit: 'BTC', fiat: '<script>' } })
    render(<Amount btc={1} variant="hero" />)
    expect(await screen.findByTestId('fiat-value')).toHaveTextContent('$84,822.00')
  })
  it('price unavailable: BTC still shown, clear message, details in the picker', async () => {
    mockApi({ price: (c) => ({ available: false, currency: c, error: 'Price unavailable: mempool.space: ECONNREFUSED; Coinbase: timed out after 5000 ms' }) })
    render(<Amount btc={1.5} variant="hero" testId="balance" />)
    expect(await screen.findByTestId('fiat-unavailable')).toHaveTextContent('Price unavailable')
    expect(screen.getByTestId('balance')).toHaveTextContent('1.50 BTC')
    fireEvent.click(screen.getByRole('button', { name: /BTC/ }))
    expect(screen.getByTestId('cp-price')).toHaveTextContent(/Price unavailable right now.*ECONNREFUSED/)
  })
  it('a garbage price response is treated as unavailable, never as a number', async () => {
    mockApi({ price: () => ({ available: true, currency: 'USD', priceE8: '1e9', source: 'x', fetchedAt: 1 }) })
    render(<Amount btc={1} variant="hero" />)
    expect(await screen.findByTestId('fiat-unavailable')).toBeInTheDocument()
  })
  it('stale prices are marked as last known', async () => {
    mockApi({ price: (c) => priceBody(c, { stale: true }) })
    render(<Amount btc={1} variant="hero" meta />)
    expect(await screen.findByText(/last known/)).toBeInTheDocument()
  })
  it('shows an error if the node refuses to save, but keeps the choice on screen', async () => {
    mockApi({ put: () => ({ status: 400, body: { error: 'fiat must be a supported currency code or null' } }) })
    render(<Amount btc={1} variant="hero" />)
    fireEvent.click(screen.getByRole('button', { name: /BTC/ }))
    fireEvent.click(screen.getByRole('radio', { name: /sats/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not saved on the node')
  })
  it('many amounts share one price request', async () => {
    const f = mockApi()
    render(<>{[1, 2, 3, 4].map((n) => <Amount key={n} btc={n} />)}</>)
    await waitFor(() => expect(screen.getAllByTestId('fiat-value')).toHaveLength(4))
    expect(priceCalls(f)).toEqual(['/api/prices?currency=USD'])
    await act(async () => {})
  })
})

describe('Wallets page', () => {
  it('total in exact sats with fiat; cards show fiat without nesting buttons', async () => {
    const w = (id: string, total: number) => ({ id, name: `Whitfield ${id}`, type: 'singlesig', network: 'regtest', m: 1, n: 1, watchWallet: id, cosigners: [], canSign: true, signable: true, balance: { confirmed: total, pending: 0, immature: 0, total } })
    mockApi({ other: (url) => (url === '/api/wallets' ? [w('a', 0.1), w('b', 0.2)] : {}) })
    render(<Wallets />)
    await waitFor(() => expect(screen.getByTestId('wallets-total')).toHaveTextContent('0.30 BTC'))
    await waitFor(() => expect(screen.getAllByTestId('fiat-value').map((e) => e.textContent)).toEqual(['≈ $25,446.60', '≈ $8,482.20', '≈ $16,964.40']))
    for (const card of screen.getAllByTestId('wallet-card')) expect(card.querySelector('button')).toBeNull()
  })
})
