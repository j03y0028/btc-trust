/**
 * Copy text. navigator.clipboard only exists in secure contexts (https:// or localhost); on plain-HTTP LAN
 * access (http://192.168.x.x) fall back to a hidden textarea + execCommand('copy'), which still works there.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select(); ta.setSelectionRange(0, text.length)
    const ok = document.execCommand?.('copy') ?? false
    ta.remove()
    return ok
  } catch { return false }
}
