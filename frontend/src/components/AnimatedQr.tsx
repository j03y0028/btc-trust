import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { PsbtURDecoder, psbtEncoder } from '../lib/ur'

/** Animated BC-UR QR (ur:crypto-psbt) with fountain-coded frames. */
export function AnimatedQr(props: { psbt: string; size?: number; fps?: number; fragment?: number; paused?: boolean }) {
  const err = useMemo(() => { try { psbtEncoder(props.psbt, props.fragment); return null } catch (e) { return (e as Error).message } }, [props.psbt, props.fragment])
  return err ? <p className="hint warn-text">Cannot encode as UR: {err}</p> : <AnimatedQrInner {...props} />
}
function AnimatedQrInner({ psbt, size = 240, fps = 5, fragment = 200, paused = false }: { psbt: string; size?: number; fps?: number; fragment?: number; paused?: boolean }) {
  const enc = useMemo(() => psbtEncoder(psbt, fragment), [psbt, fragment])
  const [frame, setFrame] = useState(() => ({ n: 1, part: enc.next() }))
  const [svg, setSvg] = useState('')
  useEffect(() => { setFrame({ n: 1, part: enc.next() }) }, [enc])
  useEffect(() => {
    if (paused || enc.single) return
    const t = setInterval(() => setFrame((f) => ({ n: f.n + 1, part: enc.next() })), 1000 / fps)
    return () => clearInterval(t)
  }, [enc, fps, paused])
  useEffect(() => {
    let live = true
    QRCode.toString(frame.part, { type: 'svg', margin: 1, errorCorrectionLevel: 'L', color: { dark: '#0b0c12', light: '#ffffff' } }).then((s) => live && setSvg(s)).catch(() => {})
    return () => { live = false }
  }, [frame.part])
  const seq = /\/(\d+)-(\d+)\//.exec(frame.part)
  const idx = seq ? Number(seq[1]) : 1
  return (
    <div className="aqr" data-testid="animated-qr" data-part={frame.part}>
      <div className="qr aqr-code" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="aqr-meta">
        <span className="aqr-badge">UR · crypto-psbt</span>
        <span className="mono tiny">{enc.single ? 'single frame' : idx <= enc.fragments ? `frame ${idx} / ${enc.fragments}` : `fountain frame #${idx} (mixes ${enc.fragments})`}</span>
      </div>
      {!enc.single && <div className="aqr-bar">{Array.from({ length: enc.fragments }, (_, i) => <i key={i} className={((idx - 1) % enc.fragments) === i ? 'on' : ''} />)}</div>}
    </div>
  )
}

/** Scan an animated UR QR from the camera (jsQR), or paste the parts. Calls onPsbt when the fountain decoder completes. */
export function UrScanner({ onPsbt, onClose }: { onPsbt: (psbtB64: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const dec = useRef(new PsbtURDecoder())
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('Point the camera at the animated QR')
  const [paste, setPaste] = useState('')
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting')
  const feed = (part: string) => {
    const r = dec.current.receive(part)
    if (r.error) { setStatus(r.error); return false }
    setProgress(r.progress)
    if (r.done && r.psbt) { setStatus('PSBT received ✓'); onPsbt(r.psbt); return true }
    setStatus(`Receiving… ${Math.round(r.progress * 100)}% (${dec.current.seen} frames)`)
    return false
  }
  useEffect(() => {
    let stream: MediaStream | null = null, raf = 0, stop = false
    const canvas = document.createElement('canvas')
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s
      if (!video.current) return
      video.current.srcObject = s; video.current.play(); setCamera('on')
      const tick = () => {
        if (stop) return
        const v = video.current
        if (v && v.videoWidth) {
          canvas.width = v.videoWidth; canvas.height = v.videoHeight
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!
          ctx.drawImage(v, 0, 0)
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
          if (code?.data && feed(code.data)) return
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }).catch(() => setCamera('off')) ?? setCamera('off')
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ur-scan" data-testid="ur-scanner">
      {camera !== 'off' ? <video ref={video} className="ur-video" muted playsInline /> : <div className="ur-video off">{window.isSecureContext === false ? 'The camera needs HTTPS (https://mynode.local:9331): paste the UR parts below' : 'Camera unavailable: paste the UR parts below'}</div>}
      <div className="ur-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      <div className="muted small" role="status">{status}</div>
      <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="…or paste UR:CRYPTO-PSBT/… parts, one per line" spellCheck={false} />
      <div className="row-gap">
        <button className="btn small" disabled={!paste.trim()} onClick={() => { for (const l of paste.split(/\s+/).filter(Boolean)) if (feed(l)) break }}>Decode parts</button>
        <button className="btn small ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
