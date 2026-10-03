import { useEffect, useState } from 'react'
import { fmt } from '../lib/api'
import { navigate } from '../lib/router'
import { msgApi, type Alert } from '../lib/messaging'

/** App-wide escalation: urgent trustee messages stay visible until every recipient has read them. */
export function UrgentBanner({ path }: { path: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  useEffect(() => {
    let on = true
    const load = () => msgApi.alerts().then((a) => on && setAlerts(Array.isArray(a) ? a.filter((x) => x && Array.isArray(x.unreadBy) && x.walletId) : [])).catch(() => {})
    load()
    const t = setInterval(load, 4000)
    return () => { on = false; clearInterval(t) }
  }, [path])
  if (!alerts.length) return null
  const a = alerts[0]
  return (
    <div className="urgent-banner" role="alert" data-testid="urgent-banner">
      <span className="siren">🚨</span>
      <div className="ub-body">
        <strong>Urgent message from {a.senderLabel}</strong>
        <span>{a.walletName} · {a.threadId === 'group' ? 'all trustees' : 'direct'} · {fmt.ago(Date.parse(a.createdAt) / 1000)} · unread by {a.unreadBy.length} trustee{a.unreadBy.length > 1 ? 's' : ''}{alerts.length > 1 ? ` · +${alerts.length - 1} more` : ''}</span>
      </div>
      <button className="btn small" onClick={() => navigate(`/messages/${a.walletId}?thread=${encodeURIComponent(a.threadId)}`)}>Open</button>
    </div>
  )
}
