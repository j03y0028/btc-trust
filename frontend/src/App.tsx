import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type BlockSummary, type ChainSummary, type Stage } from './lib/api'
import { navigate, useQuery, useRoute } from './lib/router'
import { DEFAULT_STAGES } from './components/StageTracker'
import { Dashboard } from './pages/Dashboard'
import { Wallets } from './pages/Wallets'
import { WalletDetail } from './pages/WalletDetail'
import { Devices } from './pages/Devices'

const POLL_MS = 5000

export default function App() {
  const path = useRoute()
  const [chain, setChain] = useState<ChainSummary | null>(null)
  const [blocks, setBlocks] = useState<BlockSummary[]>([])
  const [stages, setStages] = useState<Stage[]>(DEFAULT_STAGES)
  const [error, setError] = useState<string | null>(null)
  const [newest, setNewest] = useState<number>()
  const lastHeight = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [c, b] = await Promise.all([api.blockchain(), api.blocks(8)])
      if (lastHeight.current !== null && c.height > lastHeight.current) setNewest(c.height)
      lastHeight.current = c.height
      setChain(c); setBlocks(b); setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    refresh()
    api.stages().then(setStages).catch(() => {})
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  const query = useQuery(path)
  const walletId = path.match(/^\/wallets\/([^/?]+)/)?.[1]
  const section = path.startsWith('/wallets') ? 'wallets' : path.startsWith('/devices') ? 'devices' : 'dashboard'
  const preset = query.new === 'multisig' || query.new === 'singlesig' ? { choice: query.new as 'multisig' | 'singlesig', hw: query.hw } : undefined

  return (
    <div className="app">
      <div className="bg-orbs" aria-hidden><span /><span /><span /></div>
      <header className="topbar">
        <div className="brand">
          <div className="logo">₿</div>
          <div>
            <h1>BTC Trust</h1>
            <p className="muted">Sovereign family trust</p>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          <span className={`nav-indicator at-${section}`} aria-hidden />
          <button className={section === 'dashboard' ? 'active' : ''} onClick={() => navigate('/')}>Dashboard</button>
          <button className={section === 'wallets' ? 'active' : ''} onClick={() => navigate('/wallets')}>Wallets</button>
          <button className={section === 'devices' ? 'active' : ''} onClick={() => navigate('/devices')}>Devices</button>
        </nav>
        <div className="status">
          {chain && <span className={`net net-${chain.network}`}>{chain.network}</span>}
          {chain && <span className="height-chip">#{chain.height.toLocaleString('en-US')}</span>}
          <span className={`live ${error ? 'down' : chain ? 'up' : ''}`}>
            <i />{error ? 'Node offline' : chain ? 'Connected' : 'Connecting…'}
          </span>
        </div>
      </header>

      {error && <div className="glass alert" role="alert">⚠ {error}</div>}

      <div key={path} className="route">
        {walletId ? <WalletDetail id={walletId} />
          : section === 'wallets' ? <Wallets preset={preset} />
          : section === 'devices' ? <Devices />
          : <Dashboard chain={chain} blocks={blocks} stages={stages} newest={newest} />}
      </div>

      <footer className="foot muted">
        Regtest only · no real funds · private keys never leave bitcoind · <a href="https://bitcoin.org/bitcoin.pdf" target="_blank" rel="noreferrer">Bitcoin white paper</a>
      </footer>
    </div>
  )
}
