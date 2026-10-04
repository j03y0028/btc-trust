import { useState } from 'react'
import { copyText } from '../lib/clipboard'

/** Copy button that works over plain HTTP too, and says so honestly when copying is not possible. */
export function CopyButton({ text, label = 'Copy', className = 'btn small ghost' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const click = async () => {
    const ok = await copyText(text)
    setState(ok ? 'ok' : 'fail')
    setTimeout(() => setState('idle'), ok ? 1500 : 4000)
  }
  return (
    <button type="button" className={className} onClick={click} title={state === 'fail' ? 'This browser blocked copying here: select the text and copy it manually' : undefined}>
      {state === 'ok' ? 'Copied ✓' : state === 'fail' ? 'Copy blocked: select manually' : label}
    </button>
  )
}
