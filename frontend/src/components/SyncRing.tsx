export function SyncRing({ pct }: { pct: number }) {
  const r = 52
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="ring" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100} aria-label="Sync progress">
      <svg viewBox="0 0 120 120">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f7931a" />
            <stop offset="100%" stopColor="#ffcf70" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={r} className="ring-track" />
        <circle cx="60" cy="60" r={r} className="ring-fill" stroke="url(#ringGrad)"
          strokeDasharray={c} strokeDashoffset={c * (1 - clamped / 100)} />
      </svg>
      <div className="ring-label"><strong>{clamped.toFixed(clamped === 100 ? 0 : 2)}%</strong><span>synced</span></div>
    </div>
  )
}
