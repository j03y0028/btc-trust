import { fmt, type BlockSummary, type ChainSummary, type ModeInfo, type Stage } from '../lib/api'
import { StatCard } from '../components/StatCard'
import { SyncRing } from '../components/SyncRing'
import { RecentBlocks } from '../components/RecentBlocks'
import { StageTracker } from '../components/StageTracker'

export function Dashboard({ chain, blocks, stages, newest, mode, walletChain }: { chain: ChainSummary | null; blocks: BlockSummary[]; stages: Stage[]; newest?: number; mode?: ModeInfo | null; walletChain?: ChainSummary | null }) {
  const split = mode?.mode === 'split' && mode.mainnet.configured ? mode : null
  const main = split && split.mainnet.configured ? split.mainnet : null
  return (
    <main className="grid">
      <section className="glass card hero">
        <div className="hero-left">
          <span className="eyebrow">{main ? <>Block height · your node{main.expectChain === 'main' ? '' : ` (${main.expectChain} stand-in)`} · <span className="ro-pill">read-only</span></> : 'Block height'}</span>
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

      {split && main && (
        <section className="glass card wallet-chain" data-testid="wallet-chain">
          <div className="wc-row">
            <span className="eyebrow">Wallet test chain</span>
            {split.wallet.enabled ? <span className={`net net-${split.wallet.network}`}>{split.wallet.network}</span> : <span className="net">off</span>}
          </div>
          {split.wallet.enabled
            ? <div className="wc-row"><span className="wc-h">{walletChain ? `#${fmt.int(walletChain.height)}` : '—'}</span><span className="muted">{walletChain ? `${walletChain.node.subversion} · bundled test node` : 'Connecting…'}</span></div>
            : <span className="muted">Wallets, vault and messaging are switched off on this deployment.</span>}
          <span className="hint">Wallets, PSBTs, vault and trustee messaging run here with test coins. Your node only ever receives these read-only calls:</span>
          <div className="ro-methods">{main.methods.map((m) => <code key={m}>{m}</code>)}</div>
        </section>
      )}

      <RecentBlocks blocks={blocks} newest={newest} />
      <StageTracker stages={stages} />
    </main>
  )
}
