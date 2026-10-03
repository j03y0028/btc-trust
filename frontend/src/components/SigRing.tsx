export function SigRing({ have, need, size = 120 }: { have: number; need: number; size?: number }) {
  const r = 46, c = 2 * Math.PI * r
  const pct = need ? Math.min(1, have / need) : 0
  return (
    <div className={`ring sig-ring ${pct >= 1 ? 'done' : ''}`} style={{ width: size, height: size }} data-testid="sig-progress">
      <svg viewBox="0 0 110 110">
        <circle cx="55" cy="55" r={r} className="ring-track" />
        <circle cx="55" cy="55" r={r} className="ring-fill" stroke={pct >= 1 ? '#3ee59a' : '#f7931a'} strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
      </svg>
      <div className="ring-label"><strong>{have}/{need}</strong><span>signatures</span></div>
    </div>
  )
}
