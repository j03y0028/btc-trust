import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { StageTracker, DEFAULT_STAGES } from './components/StageTracker'
import { fmt } from './lib/api'

const chain = {
  network: 'regtest', height: 1234, headers: 1234, bestBlockHash: 'ab'.repeat(32), difficulty: 4.6565423739069247e-10,
  verificationProgress: 1, syncProgressPct: 100, initialBlockDownload: false, sizeOnDisk: 300000, pruned: false,
  mempool: { size: 3, bytes: 600, usage: 2000, totalFeeBtc: 0.0001 },
  node: { version: 310100, subversion: '/Satoshi:31.1.0/', connections: 0 }, timestamp: new Date().toISOString(),
}
const blocks = [1234, 1233].map((h) => ({ height: h, hash: String(h).padStart(64, '0'), time: Date.now() / 1000 - 30, txCount: 1, size: 250, weight: 1000, difficulty: 1 }))

describe('App dashboard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.startsWith('/api/blockchain') ? chain : url.startsWith('/api/blocks') ? blocks : DEFAULT_STAGES
      return new Response(JSON.stringify(body), { status: 200 })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('renders chain stats from the API', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('height')).toHaveTextContent('1,234'))
    expect(screen.getByText('regtest')).toBeInTheDocument()
    expect(screen.getByText('3 tx')).toBeInTheDocument()
    expect(screen.getByText('#1,233')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })

  it('shows an error banner when the node is offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Cannot reach bitcoind' }), { status: 502 })))
    render(<App />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach bitcoind'))
    expect(screen.getByText('Node offline')).toBeInTheDocument()
  })
})

describe('StageTracker', () => {
  it('lists all stages and marks stages 0-8 complete', () => {
    render(<StageTracker stages={DEFAULT_STAGES} />)
    for (let i = 0; i <= 8; i++) expect(screen.getByTestId(`stage-${i}`)).toBeInTheDocument()
    expect(screen.getByTestId('stage-1')).toHaveClass('stage-complete')
    expect(screen.getByTestId('stage-2')).toHaveClass('stage-complete')
    expect(screen.getByTestId('stage-3')).toHaveClass('stage-complete')
    expect(screen.getByTestId('stage-4')).toHaveClass('stage-complete')
    expect(screen.getByTestId('stage-5')).toHaveClass('stage-complete')
    expect(screen.getByTestId('stage-6')).toHaveClass('stage-complete')
    expect(screen.getByTestId('stage-7')).toHaveClass('stage-complete')
    expect(screen.getByTestId('stage-8')).toHaveClass('stage-in-progress')
    expect(screen.getByTestId('stage-count')).toHaveTextContent('8/9')
  })
})

describe('formatters', () => {
  it('format numbers, bytes and hashes', () => {
    expect(fmt.int(1234567)).toBe('1,234,567')
    expect(fmt.bytes(2048)).toBe('2.0 KB')
    expect(fmt.hash('0123456789abcdef', 3)).toBe('012…def')
    expect(fmt.ago(100, 160_000)).toBe('1m ago')
    expect(fmt.diff(4.6565423739069247e-10)).toBe('4.657e-10')
    expect(fmt.diff(1.5)).toBe('1.5')
    expect(fmt.diff(1.2e14)).toBe('120.00 T')
  })
})
