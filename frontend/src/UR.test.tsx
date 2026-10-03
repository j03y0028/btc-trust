import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { PsbtURDecoder, psbtEncoder, psbtToUR } from './lib/ur'
import { AnimatedQr, UrScanner } from './components/AnimatedQr'
import PSBT from './fixtures/psbt-3of5.txt?raw'

const big = PSBT.trim() // real regtest 3-of-5 P2WSH PSBT (1760 base64 chars)
afterEach(() => vi.useRealTimers())

/** Render a QR payload to an RGBA bitmap (what a camera frame would contain) and decode it with jsQR. */
function cameraRoundTrip(text: string) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L' })
  const n = qr.modules.size, scale = 4, margin = 4, w = (n + margin * 2) * scale
  const px = new Uint8ClampedArray(w * w * 4).fill(255)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!qr.modules.get(y, x)) continue
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + margin) * scale + dy) * w + (x + margin) * scale + dx) * 4
      px[i] = px[i + 1] = px[i + 2] = 0
    }
  }
  return jsQR(px, w, w)?.data
}

describe('BC-UR crypto-psbt (animated QR)', () => {
  it('encodes a PSBT as CBOR bytes under ur:crypto-psbt and splits it into fountain frames', () => {
    expect(psbtToUR(big).type).toBe('crypto-psbt')
    const e = psbtEncoder(big, 200)
    expect(e.single).toBe(false)
    expect(e.fragments).toBeGreaterThanOrEqual(6)
    expect(e.next()).toMatch(/^UR:CRYPTO-PSBT\/1-\d+\/[A-Z]+$/)
    expect(psbtEncoder(big, 5000).single).toBe(true)
    expect(() => psbtEncoder(btoa('not a psbt'))).toThrow(/magic/)
  })
  it('round-trips through real QR images: render → jsQR scan → fountain decoder → identical PSBT', () => {
    const e = psbtEncoder(big, 200)
    const d = new PsbtURDecoder()
    let out: ReturnType<PsbtURDecoder['receive']> | undefined
    for (let i = 0; i < e.fragments * 3 && !out?.done; i++) {
      const scanned = cameraRoundTrip(e.next())
      expect(scanned).toBeTruthy()
      out = d.receive(scanned!)
    }
    expect(out?.done).toBe(true)
    expect(out?.psbt).toBe(big)
  })
  it('fountain codes: completes even when the scanner misses frames and starts mid-stream', () => {
    const e = psbtEncoder(big, 150)
    const parts = Array.from({ length: e.fragments * 4 }, () => e.next())
    const d = new PsbtURDecoder()
    let r: ReturnType<PsbtURDecoder['receive']> | undefined
    for (const [i, p] of parts.entries()) {
      if (i < 3 || i % 3 === 0) continue // joined late and drops every third frame
      r = d.receive(p)
      if (r.done) break
    }
    expect(r?.done).toBe(true)
    expect(r?.psbt).toBe(big)
  })
  it('rejects non-UR codes, other UR types and corrupted parts', () => {
    const d = new PsbtURDecoder()
    expect(d.receive('bitcoin:bcrt1qxyz').error).toMatch(/Not a UR/)
    expect(d.receive('ur:bytes/hdcxdwmh').error).toMatch(/Expected ur:crypto-psbt/)
    const part = psbtEncoder(big, 200).next().toLowerCase()
    const tampered = part.slice(0, -6) + (part.endsWith('aeae') ? 'bdbdbdbd' : 'aeaeaeae').slice(0, 6)
    const bad = new PsbtURDecoder().receive(tampered)
    expect(bad).toMatchObject({ done: false, error: /Bad frame|checksum/i })
  })
  it('AnimatedQr cycles frames; the scanner (paste fallback) decodes them back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onPsbt = vi.fn()
    render(<><AnimatedQr psbt={big} fps={10} /><UrScanner onPsbt={onPsbt} onClose={() => {}} /></>)
    const qr = screen.getByTestId('animated-qr')
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) { seen.add(qr.getAttribute('data-part')!); await act(async () => { vi.advanceTimersByTime(100) }) }
    expect(seen.size).toBeGreaterThan(10)
    expect(screen.getByText(/UR · crypto-psbt/)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/paste UR:CRYPTO-PSBT/), { target: { value: [...seen].join('\n') } })
    fireEvent.click(screen.getByRole('button', { name: 'Decode parts' }))
    expect(onPsbt).toHaveBeenCalledWith(big)
    expect(screen.getByRole('status')).toHaveTextContent('PSBT received ✓')
  })
})
