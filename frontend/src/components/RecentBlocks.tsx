import { fmt, type BlockSummary } from '../lib/api'

export function RecentBlocks({ blocks, newest }: { blocks: BlockSummary[]; newest?: number }) {
  return (
    <div className="glass card blocks">
      <div className="card-title"><h2>Recent blocks</h2><span className="pill">{blocks.length} shown</span></div>
      <ul className="block-list">
        {blocks.map((b) => (
          <li key={b.hash} className={`block-row ${b.height === newest ? 'is-new' : ''}`}>
            <div className="cube" aria-hidden><span /></div>
            <div className="block-main">
              <div className="block-height">#{fmt.int(b.height)}</div>
              <code className="block-hash" title={b.hash}>{fmt.hash(b.hash, 8)}</code>
            </div>
            <div className="block-meta">
              <span>{b.txCount} tx</span>
              <span>{fmt.bytes(b.size)}</span>
              <span className="muted">{fmt.ago(b.time)}</span>
            </div>
          </li>
        ))}
        {blocks.length === 0 && <li className="muted">No blocks yet.</li>}
      </ul>
    </div>
  )
}
