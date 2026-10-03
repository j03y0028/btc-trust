import { fmt, type BlockSummary, type ChainSummary, type Stage } from '../lib/api'
import { StatCard } from '../components/StatCard'
import { SyncRing } from '../components/SyncRing'
import { RecentBlocks } from '../components/RecentBlocks'
import { StageTracker } from '../components/StageTracker'

export function Dashboard({ chain, blocks, stages, newest }: { chain: ChainSummary | null; blocks: BlockSummary[]; stages: Stage[]; newest?: number }) {
  return (
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
  )
}
