import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    let live = true
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0c12', light: '#ffffff' } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(''))
    return () => { live = false }
  }, [value])
  return <div className="qr" style={{ width: size, height: size }} data-testid="qr" aria-label={`QR code for ${value}`} dangerouslySetInnerHTML={{ __html: svg }} />
}
