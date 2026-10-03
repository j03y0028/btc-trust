import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type BlockSummary, type ChainSummary, type ModeInfo, type Stage } from './lib/api'
import { AuthGate } from './components/AuthGate'
import { navigate, useQuery, useRoute } from './lib/router'
import { DEFAULT_STAGES } from './components/StageTracker'
import { Dashboard } from './pages/Dashboard'
import { Wallets } from './pages/Wallets'
import { WalletDetail } from './pages/WalletDetail'
import { Devices } from './pages/Devices'
import { VaultIndex, VaultPage } from './pages/Vault'
import { MessagesIndex, MessagesPage } from './pages/Messages'
import { KeyGate } from './components/KeyGate'
import { UrgentBanner } from './components/UrgentBanner'
import { Timeline } from './pages/Timeline'
import { Goals } from './pages/Goals'

const POLL_MS = 5000

export default function App() {
  return <AuthGate>{({ status, logout }) => <Shell authRequired={status.required} logout={logout} />}</AuthGate>
}

function Shell({ authRequired, logout }: { authRequired: boolean; logout: () => void }) {
  const path = useRoute()
  const [mode, setMode] = useState<ModeInfo | null | undefined>(undefined) // undefined = loading, null = unavailable
  const [walletChain, setWalletChain] = useState<ChainSummary | null>(null)
  const split = mode?.mode === 'split'
  const walletsOn = mode?.wallet.enabled ?? true
  const [chain, setChain] = useState<ChainSummary | null>(null)
  const [blocks, setBlocks] = useState<BlockSummary[]>([])
  const [stages, setStages] = useState<Stage[]>(DEFAULT_STAGES)
  const [error, setError] = useState<string | null>(null)
  const [newest, setNewest] = useState<number>()
  const lastHeight = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      // Split (myNode): dashboard + header show the mainnet node (read-only); wallets run on the test chain.
      const source = split ? 'mainnet' as const : 'wallet' as const
      if (split && walletsOn) api.blockchain('wallet').then(setWalletChain).catch(() => setWalletChain(null))
      const [c, b] = await Promise.all([api.blockchain(source), api.blocks(8, source)])
      if (lastHeight.current !== null && c.height > lastHeight.current) setNewest(c.height)
      lastHeight.current = c.height
      setChain(c); setBlocks(b); setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [split, walletsOn])

  useEffect(() => { api.mode().then((m) => setMode(m && typeof m === 'object' && 'mode' in m && 'wallet' in m ? m : null)).catch(() => setMode(null)) }, [])
  useEffect(() => {
    if (mode === undefined) return
    refresh()
    api.stages().then(setStages).catch(() => {})
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh, mode])

  const query = useQuery(path)
  const walletId = path.match(/^\/wallets\/([^/?]+)/)?.[1]
  const vaultId = path.match(/^\/vault\/([^/?]+)/)?.[1]
  const msgId = path.match(/^\/messages\/([^/?]+)/)?.[1]
  const section = path.startsWith('/wallets') ? 'wallets' : path.startsWith('/devices') ? 'devices' : path.startsWith('/vault') ? 'vault' : path.startsWith('/messages') ? 'messages' : path.startsWith('/timeline') ? 'timeline' : path.startsWith('/goals') ? 'goals' : 'dashboard'
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
          {walletsOn && <>
            <button className={section === 'wallets' ? 'active' : ''} onClick={() => navigate('/wallets')}>Wallets</button>
            <button className={section === 'devices' ? 'active' : ''} onClick={() => navigate('/devices')}>Devices</button>
            <button className={section === 'vault' ? 'active' : ''} onClick={() => navigate('/vault')}>Vault</button>
            <button className={section === 'messages' ? 'active' : ''} onClick={() => navigate('/messages')}>Messages</button>
          </>}
          <button className={section === 'timeline' ? 'active' : ''} onClick={() => navigate('/timeline')}>Timeline</button>
          <button className={section === 'goals' ? 'active' : ''} onClick={() => navigate('/goals')}>Goals</button>
        </nav>
        <div className="status">
          {chain && <span className={`net net-${chain.network}`} data-testid="net-badge">{chain.network}</span>}
          {split && <span className="ro-pill" title="Only allowlisted read-only RPCs reach your node">read-only</span>}
          {chain && <span className="height-chip">#{chain.height.toLocaleString('en-US')}</span>}
          <span className={`live ${error ? 'down' : chain ? 'up' : ''}`}>
            <i />{error ? 'Node offline' : chain ? 'Connected' : 'Connecting…'}
          </span>
          {authRequired && <button className="btn ghost logout" onClick={logout} data-testid="logout">Sign out</button>}
        </div>
      </header>

      {split && mode?.mainnet.configured && (
        <div className="glass split-banner" data-testid="split-banner">
          <span className="sb-item">⛓ <span>Chain data: <b>your node · {mode.mainnet.expectChain === 'main' ? 'mainnet' : `${mode.mainnet.expectChain} (stand-in)`}</b> · read-only RPC allowlist ({mode.mainnet.methods.length} methods)</span></span>
          <span className="sb-item sb-test">🧪 <span>{walletsOn ? <>Wallets, vault, messaging &amp; PSBTs: <b>{(mode.wallet.network ?? '').toUpperCase()} test coins only</b>. Never real bitcoin.</> : <>Wallet features are <b>off</b> on this node.</>}</span></span>
        </div>
      )}
      {error && <div className="glass alert" role="alert">⚠ {error}</div>}
      <UrgentBanner path={path} />

      <div key={path} className="route">
        {walletId ? <WalletDetail id={walletId} />
          : vaultId ? <VaultPage walletId={vaultId} />
          : msgId ? <KeyGate><MessagesPage key={msgId + (query.thread ?? '')} walletId={msgId} initialThread={query.thread} /></KeyGate>
          : section === 'messages' ? <MessagesIndex />
          : section === 'vault' ? <VaultIndex />
          : section === 'wallets' ? <Wallets preset={preset} />
          : section === 'devices' ? <Devices />
          : section === 'timeline' ? <Timeline />
          : section === 'goals' ? <Goals />
          : <Dashboard chain={chain} blocks={blocks} stages={stages} newest={newest} mode={mode} walletChain={walletChain} />}
      </div>

      <footer className="foot muted">
        {split ? 'Mainnet: read-only observation of your node · wallets, vault and messaging use test coins only' : 'Regtest only · no real funds'} · private keys never leave bitcoind · vault documents encrypted at rest · mainnet data read-only · <a href="https://bitcoin.org/bitcoin.pdf" target="_blank" rel="noreferrer">Bitcoin white paper</a>
      </footer>
    </div>
  )
}
