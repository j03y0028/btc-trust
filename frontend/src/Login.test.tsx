import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { DEFAULT_STAGES } from './components/StageTracker'
import { installAuthInterceptor } from './lib/auth'

const chain = (network: string, height: number) => ({
  network, height, headers: height, bestBlockHash: 'ab'.repeat(32), difficulty: 1.2e14, verificationProgress: 1, syncProgressPct: 100,
  initialBlockDownload: false, sizeOnDisk: 7e11, pruned: false, mempool: { size: 4210, bytes: 2_100_000, usage: 9e6, totalFeeBtc: 0.12 },
  node: { version: 290300, subversion: '/Satoshi:29.3.0/', connections: 10 }, timestamp: new Date().toISOString(),
})
const METHODS = ['getblockchaininfo', 'getblockcount', 'getblock']
const split = (walletEnabled = true) => ({ mode: 'split', mainnet: { configured: true, readOnly: true, expectChain: 'main', auth: 'rpcauth', methods: METHODS, refused: 0 }, wallet: { enabled: walletEnabled, network: walletEnabled ? 'regtest' : null }, auth: { required: true } })

/** A tiny fake backend: login state + split mode. */
function backend(opts: { configured: boolean; walletEnabled?: boolean }) {
  let authed = false
  let configured = opts.configured
  const calls: string[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
    if (url === '/api/auth/status') return json({ required: true, configured, authenticated: authed, setupTokenRequired: !configured, minLength: 12 })
    if (url === '/api/auth/setup') {
      const b = JSON.parse(String(init?.body))
      if (b.setupToken !== 'TOKEN-123') return json({ error: 'Setup token is wrong (see the myNode app page or data/setup-token)' }, 403)
      configured = true; authed = true; return json({ ok: true }, 201)
    }
    if (url === '/api/auth/login') {
      if (JSON.parse(String(init?.body)).passphrase !== 'correct horse battery') return json({ error: 'Wrong passphrase' }, 401)
      authed = true; return json({ ok: true })
    }
    if (url === '/api/auth/logout') { authed = false; return json({ ok: true }) }
    if (!authed) return json({ error: 'Login required', auth: 'required' }, 401, { 'x-auth-required': '1' })
    if (url === '/api/mode') return json(split(opts.walletEnabled ?? true))
    if (url === '/api/blockchain?source=mainnet') return json(chain('main', 969_701))
    if (url === '/api/blockchain') return json(chain('regtest', 489))
    if (url.startsWith('/api/blocks')) return json([{ height: url.includes('mainnet') ? 969_701 : 489, hash: '1'.repeat(64), time: Date.now() / 1000 - 60, txCount: 3000, size: 1.5e6, weight: 4e6, difficulty: 1 }])
    if (url === '/api/stages') return json(DEFAULT_STAGES)
    return json([])
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, expire: () => { authed = false } }
}

describe('app login + myNode split mode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('first run: asks for the setup token and a passphrase, then opens the app', async () => {
    const b = backend({ configured: false })
    render(<App />)
    expect(await screen.findByTestId('login-setup')).toBeInTheDocument()
    expect(b.calls.some((c) => c.includes('/api/blockchain'))).toBe(false) // nothing loads before login
    const btn = screen.getByRole('button', { name: /Set passphrase & sign in/ })
    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: 'WRONG' } })
    fireEvent.change(screen.getByLabelText('New app passphrase'), { target: { value: 'correct horse battery' } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'correct horse battery' } })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Setup token is wrong/)
    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: ' TOKEN-123 ' } })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('height')).toHaveTextContent('969,701'))
  })

  it('rejects a short or mismatched new passphrase in the form', async () => {
    backend({ configured: false })
    render(<App />)
    await screen.findByTestId('login-setup')
    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: 'TOKEN-123' } })
    fireEvent.change(screen.getByLabelText('New app passphrase'), { target: { value: 'short' } })
    expect(screen.getByText('At least 12 characters')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New app passphrase'), { target: { value: 'long enough passphrase' } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'different passphrase' } })
    expect(screen.getByText('Passphrases don’t match')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Set passphrase/ })).toBeDisabled()
  })

  it('login shows the mainnet node read-only and the wallets on the test chain', async () => {
    const b = backend({ configured: true })
    render(<App />)
    await screen.findByTestId('login')
    fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong passphrase')
    fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByTestId('height')).toHaveTextContent('969,701'))
    expect(screen.getByTestId('net-badge')).toHaveTextContent('main')
    expect(screen.getByTestId('split-banner')).toHaveTextContent(/your node · mainnet · read-only RPC allowlist \(3 methods\)/)
    expect(screen.getByTestId('split-banner')).toHaveTextContent(/REGTEST test coins only/)
    await waitFor(() => expect(screen.getByTestId('wallet-chain')).toHaveTextContent('#489'))
    for (const m of METHODS) expect(screen.getByTestId('wallet-chain')).toHaveTextContent(m)
    expect(b.calls).toContain('GET /api/blockchain?source=mainnet')
    expect(b.calls).toContain('GET /api/blocks?count=8&source=mainnet')
    expect(screen.getByRole('button', { name: 'Wallets' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('logout'))
    expect(await screen.findByTestId('login')).toBeInTheDocument()
  })

  it('hides wallet sections when wallet features are off', async () => {
    backend({ configured: true, walletEnabled: false })
    render(<App />)
    fireEvent.change(await screen.findByLabelText('App passphrase'), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByTestId('height')).toHaveTextContent('969,701'))
    expect(screen.queryByRole('button', { name: 'Wallets' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Vault' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Timeline' })).toBeInTheDocument()
    expect(screen.getByTestId('split-banner')).toHaveTextContent(/Wallet features are off/)
  })

  it('an expired session anywhere sends the user back to the login screen', async () => {
    const b = backend({ configured: true })
    installAuthInterceptor()
    render(<App />)
    fireEvent.change(await screen.findByLabelText('App passphrase'), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByTestId('height')).toHaveTextContent('969,701'))
    b.expire()
    await window.fetch('/api/wallets') // any call → 401 x-auth-required
    expect(await screen.findByTestId('login')).toBeInTheDocument()
  })
})
