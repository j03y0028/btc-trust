import { useCallback, useEffect, useRef, useState } from 'react'
import { api, fmt, type BlockSummary, type ChainSummary, type Stage } from './lib/api'
import { StatCard } from './components/StatCard'
import { SyncRing } from './components/SyncRing'
import { RecentBlocks } from './components/RecentBlocks'
import { DEFAULT_STAGES, StageTracker } from './components/StageTracker'

const POLL_MS = 5000

export default function App() {
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

  return (
    <div className="app">
      <div className="bg-orbs" aria-hidden><span /><span /><span /></div>
      <header className="topbar">
        <div className="brand">
          <div className="logo">₿</div>
          <div>
            <h1>BTC Trust</h1>
            <p className="muted">Sovereign family trust · node dashboard</p>
          </div>
        </div>
        <div className="status">
          {chain && <span className={`net net-${chain.network}`}>{chain.network}</span>}
          <span className={`live ${error ? 'down' : chain ? 'up' : ''}`}>
            <i />{error ? 'Node offline' : chain ? 'Connected' : 'Connecting…'}
          </span>
        </div>
      </header>

      {error && <div className="glass alert" role="alert">⚠ {error}</div>}

      <main className="grid">
        <section className="glass card hero">
          <div className="hero-left">
            <span className="eyebrow">Block height</span>
            <div className="hero-height" data-testid="height">{chain ? fmt.int(chain.height) : '—'}</div>
            <div className="hero-hash">
              <span className="muted">Best block</span>
              <code title={chain?.bestBlockHash}>{chain ? fmt.hash(chain.bestBlockHash, 14) : '—'}</code>
            </div>
            <div className="hero-foot muted">
              {chain ? <>{chain.node.subversion} · {chain.node.connections} peers · updated {new Date(chain.timestamp).toLocaleTimeString()}</> : 'Waiting for node…'}
            </div>
          </div>
          <SyncRing pct={chain?.syncProgressPct ?? 0} />
        </section>

        <div className="stats">
          <StatCard label="Difficulty" accent="violet" icon="◆" delay={60}
            value={chain ? fmt.diff(chain.difficulty) : '—'} sub={chain ? (chain.network === 'regtest' ? 'Regtest minimum' : 'Current target') : ''} />
          <StatCard label="Mempool" accent="cyan" icon="≋" delay={120}
            value={chain ? `${fmt.int(chain.mempool.size)} tx` : '—'} sub={chain ? `${fmt.bytes(chain.mempool.bytes)} · ${chain.mempool.totalFeeBtc.toFixed(8)} BTC fees` : ''} />
          <StatCard label="Headers" accent="green" icon="▤" delay={180}
            value={chain ? fmt.int(chain.headers) : '—'} sub={chain ? (chain.initialBlockDownload ? 'Initial block download' : 'Fully validated') : ''} />
          <StatCard label="Chain size" accent="orange" icon="⬢" delay={240}
            value={chain ? fmt.bytes(chain.sizeOnDisk) : '—'} sub={chain ? (chain.pruned ? 'Pruned node' : 'Full archival') : ''} />
        </div>

        <RecentBlocks blocks={blocks} newest={newest} />
        <StageTracker stages={stages} />
      </main>

      <footer className="foot muted">
        Regtest only · no real funds · <a href="https://bitcoin.org/bitcoin.pdf" target="_blank" rel="noreferrer">Bitcoin white paper</a>
      </footer>
    </div>
  )
}
