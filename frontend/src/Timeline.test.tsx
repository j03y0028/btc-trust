import { cloneElement, type ReactElement } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Timeline } from './pages/Timeline'
import { Goals } from './pages/Goals'
import { buildRows, type DailyData, type ProgressData, type TimelineData } from './lib/timeline'

// happy-dom has no layout: give Recharts a fixed-size container so the SVG actually renders.
vi.mock('recharts', async (orig) => {
  const m = await orig<typeof import('recharts')>()
  return { ...m, ResponsiveContainer: ({ children, height }: { children: ReactElement; height: number }) => <div style={{ width: 900, height }}>{cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 900, height })}</div> }
})
afterEach(() => vi.unstubAllGlobals())
const stub = (routes: Record<string, unknown>) => {
  const f = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    return new Response(JSON.stringify(key ? routes[key] : { error: 'nope' }), { status: key ? 200 : 404 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const S = (id: string, kind: 'rate' | 'level', pts: [string, number][]) => ({ id, title: id, units: kind === 'rate' ? 'Percent' : 'Index', frequency: 'Monthly', seasonal: 'SA', kind, fetchedAt: '2026-10-03T04:09:35.087Z', csvUrl: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, sourceUrl: `https://fred.stlouisfed.org/series/${id}`, points: pts.map(([date, value]) => ({ date, value })) })
const months = ['2008-08-01', '2008-09-01', '2008-10-01', '2008-11-01', '2008-12-01', '2009-01-01']
const timeline: TimelineData = {
  series: [
    S('CPIAUCSL', 'level', months.map((d, i) => [d, 218 - i])), S('M2SL', 'level', months.map((d, i) => [d, 7800 + i * 50])),
    S('FEDFUNDS', 'rate', months.map((d, i) => [d, 2 - i * 0.3])), S('GDP', 'level', [['2008-07-01', 14891.6], ['2008-10-01', 14577]]), S('UNRATE', 'rate', months.map((d, i) => [d, 6.1 + i * 0.4])),
  ],
  events: [
    { date: '2008-09-15', kind: 'us', title: 'Lehman Brothers files for bankruptcy', detail: 'x', citation: 'https://www.federalreservehistory.org/essays/support-for-specific-institutions', source: 'Federal Reserve History' },
    { date: '2008-10-31', kind: 'bitcoin', title: 'Bitcoin white paper published', detail: 'y', citation: 'https://www.metzdowd.com/pipermail/cryptography/2008-October/014810.html', source: 'metzdowd.com' },
    { date: '2009-01-03', kind: 'bitcoin', title: 'Genesis block mined', detail: 'z', citation: 'https://mempool.space/block/000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', source: 'mempool' },
  ],
  reference: { fetchedAt: '2026-10-03T04:09:19.700Z', source: 'mempool.emzy.de', genesis: { hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', time: 1231006505, timeISO: '2009-01-03T18:15:05.000Z', headline: 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks', coinbaseTxid: '4a5e', checks: { hashIsGenesis: true, proofOfWork: true, merkleRootIsCoinbase: true, coinbaseTxid: true }, verified: true }, halvings: [] },
  whitepaper: { title: 'Bitcoin: A Peer-to-Peer Electronic Cash System', author: 'Satoshi Nakamoto', date: '2008-10-31', url: 'https://bitcoin.org/bitcoin.pdf', announcement: 'https://www.metzdowd.com/x', sha256: 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553', localPath: '/bitcoin.pdf', bundled: true, matches: true, bytes: 184292 },
  errors: [],
}
const snap = { date: '2026-10-02', takenAt: '2026-10-03T04:06:41.620Z', height: 969669, hash: '00000000000000000000e3f92bec92a336632cb8ae8505aeea153c9a16266f3f', time: 1791000055, timeISO: '2026-10-03T04:00:55.000Z', difficulty: 132757073449487.52, primary: 'mempool.space',
  check: { status: 'disagree' as const, lagBlocks: 0, notes: ['Same height 969669 but different hashes'] },
  sources: [{ name: 'mempool.space', ok: true, height: 969669, hash: 'aa' }, { name: 'blockstream.info', ok: false, error: 'HTTP 429 from blockstream.info (rate limited)' }] }
const daily: DailyData = { snapshots: [snap], latest: snap, today: '2026-10-02', hasToday: true, streakDays: 1, growing: true, blocksSinceGenesis: 969669, daysSinceWhitepaper: 6545, daysSinceGenesis: 6481,
  nextHalving: { target: 1050000, remaining: 80331, avgBlockSeconds: 590, estimatedTime: 1838400000, naiveTime: 1839200000 }, halvings: [{ height: 840000, hash: '0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5', time: 1713571767, timeISO: '2024-04-20T00:09:27.000Z', verified: true }],
  genesis: { hash: 'g', time: 1231006505 }, nodeConfigured: false, sources: ['mempool.space', 'blockstream.info'], fallbacks: ['mempool.emzy.de'] }

describe('Timeline page', () => {
  it('rebases levels to Oct 2008 = 100 and keeps rates in percent', () => {
    const rows = buildRows(timeline.series)
    const oct = rows.find((r) => r.month === '2008-10')!
    expect(oct.CPIAUCSL).toBe(100)
    expect(oct.M2SL).toBe(100)
    expect(oct.GDP).toBe(100)
    expect(oct.FEDFUNDS).toBe(1.4)
    expect(rows.find((r) => r.month === '2009-01')!.CPIAUCSL_raw).toBe(213)
  })
  it('renders stats, the chart with event overlays, sources, genesis headline and the daily log', async () => {
    stub({ '/api/timeline': timeline, '/api/mainnet/daily': daily })
    const { container } = render(<Timeline />)
    expect((await screen.findAllByText('969,669')).length).toBeGreaterThan(0)
    expect(screen.getByText('6,545')).toBeInTheDocument()
    expect(screen.getByText(/The Times 03\/Jan\/2009 Chancellor on brink of second bailout for banks/)).toBeInTheDocument()
    await waitFor(() => expect(container.querySelectorAll('.tl-chart .recharts-line').length).toBeGreaterThanOrEqual(3))
    expect(container.querySelectorAll('.tl-chart .ev-marker')).toHaveLength(3)
    // every event in the list links to its citation
    const list = container.querySelector('.ev-list') as HTMLElement
    expect(within(list).getByText('Lehman Brothers files for bankruptcy')).toBeInTheDocument()
    expect(within(list).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(timeline.events.map((e) => e.citation))
    // FRED source + fetch date shown
    expect(screen.getAllByRole('link', { name: 'CSV' })[0]).toHaveAttribute('href', 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL')
    expect(screen.getAllByText(/fetched Oct 2, 2026/).length).toBe(5)
    // white paper local copy + verified hash
    expect(screen.getByRole('link', { name: 'Open local copy' })).toHaveAttribute('href', '/bitcoin.pdf')
    expect(screen.getByText('SHA-256 ✓')).toBeInTheDocument()
    // daily log flags disagreement and the rate-limited source
    expect(screen.getAllByText('disagree').length).toBeGreaterThan(0)
    expect(screen.getByTitle('blockstream.info: HTTP 429 from blockstream.info (rate limited)')).toBeInTheDocument()
  })
  it('overlay toggles hide series and event markers', async () => {
    stub({ '/api/timeline': timeline, '/api/mainnet/daily': daily })
    const { container } = render(<Timeline />)
    await waitFor(() => expect(container.querySelectorAll('.tl-chart .ev-marker')).toHaveLength(3))
    const lines = container.querySelectorAll('.tl-chart .recharts-line').length
    fireEvent.click(screen.getByRole('button', { name: 'Bitcoin milestones' }))
    await waitFor(() => expect(container.querySelectorAll('.tl-chart .ev-marker')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'U.S. events' }))
    await waitFor(() => expect(container.querySelectorAll('.tl-chart .ev-marker')).toHaveLength(0))
    fireEvent.click(screen.getByRole('button', { name: 'Unemployment' }))
    await waitFor(() => expect(container.querySelectorAll('.tl-chart .recharts-line').length).toBe(lines - 1))
    expect(screen.getByRole('button', { name: 'Unemployment' })).toHaveAttribute('aria-pressed', 'false')
  })
})

const progress: ProgressData = {
  head: 'e31f8e9aaaa', dirty: false,
  stages: [
    { id: 0, title: 'Foundation', status: 'complete', achievements: ['Regtest node'], commit: { hash: 'c83917baaaa', short: 'c83917b', date: '2026-10-02T19:28:00-07:00', subject: 'Stage 0+1' }, tests: { backend: 15, frontend: 4, source: 'git c83917b' } },
    { id: 5, title: 'Trustee Messaging', status: 'complete', achievements: ['E2E encryption'], commit: { hash: 'e31f8e9aaaa', short: 'e31f8e9', date: '2026-10-02T20:49:30-07:00', subject: 'Stage 5' }, tests: { backend: 106, frontend: 30, source: 'git e31f8e9' } },
    { id: 6, title: 'Timeline & Goals', status: 'planned', achievements: ['FRED'], commit: null, tests: null },
  ],
  backlog: [{ title: 'Tor transport', detail: 'onion' }, { title: 'Independent security audit', detail: 'review' }],
}
describe('Goals page', () => {
  it('shows stages with commit hashes and test counts, progress summary and backlog', async () => {
    stub({ '/api/progress': progress })
    render(<Goals />)
    const s5 = await screen.findByTestId('goal-stage-5')
    expect(within(s5).getByText('e31f8e9')).toBeInTheDocument()
    expect(within(s5).getByText('136')).toBeInTheDocument()
    expect(within(s5).getByText(/106 be \/ 30 fe/)).toBeInTheDocument()
    expect(within(screen.getByTestId('goal-stage-6')).getByText('planned')).toBeInTheDocument()
    expect(screen.getByText('2/3')).toBeInTheDocument()
    expect(screen.getByText('Tor transport')).toBeInTheDocument()
    expect(screen.getByText('Independent security audit')).toBeInTheDocument()
  })
})
