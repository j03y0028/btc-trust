/**
 * BC-UR (Blockchain Commons Uniform Resources) for PSBTs: `ur:crypto-psbt/…` with fountain-coded multi-part
 * frames (BCR-2020-005/006), via @ngraveio/bc-ur. Interoperable with Sparrow, Keystone, Passport, Jade, SeedSigner…
 */
import '../polyfills'
import { UR, UREncoder, URDecoder } from '@ngraveio/bc-ur'

export const UR_TYPE = 'crypto-psbt'
// Use the same Buffer implementation bc-ur sees (polyfill in the browser, Node's in tests).
const Buf = () => (globalThis as unknown as { Buffer: typeof import('buffer').Buffer }).Buffer
const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff]

export function psbtBytes(psbtB64: string): Uint8Array {
  const b = Uint8Array.from(atob(psbtB64.trim()), (c) => c.charCodeAt(0))
  if (!PSBT_MAGIC.every((x, i) => b[i] === x)) throw new Error('Not a PSBT (missing magic bytes)')
  return b
}
export const bytesToB64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }

/** crypto-psbt = CBOR byte string of the raw PSBT. */
export function psbtToUR(psbtB64: string): UR {
  const cbor = UR.fromBuffer(Buf().from(psbtBytes(psbtB64))).cbor
  return new UR(cbor, UR_TYPE)
}

/** Fountain encoder: `nextPart()` yields an endless stream; the first `fragments` parts are the plain fragments. */
export function psbtEncoder(psbtB64: string, maxFragmentLength = 200) {
  const enc = new UREncoder(psbtToUR(psbtB64), maxFragmentLength, 0, 10)
  return { next: () => enc.nextPart().toUpperCase(), fragments: enc.fragmentsLength, single: enc.fragmentsLength === 1 }
}

/** Scanner side: feed parts in any order (duplicates and gaps fine); returns progress and the PSBT once complete. */
export class PsbtURDecoder {
  private d = new URDecoder(undefined, UR_TYPE)
  seen = 0
  receive(part: string): { done: boolean; progress: number; expected: number; psbt?: string; error?: string } {
    const p = part.trim().toLowerCase()
    if (!p.startsWith('ur:')) return { done: false, progress: this.progress(), expected: this.d.expectedPartCount(), error: 'Not a UR QR code' }
    if (!p.startsWith(`ur:${UR_TYPE}`)) return { done: false, progress: this.progress(), expected: 0, error: `Expected ur:${UR_TYPE}, got ${p.split('/')[0]}` }
    this.seen++
    try { this.d.receivePart(p) } catch (e) { return { done: false, progress: this.progress(), expected: this.d.expectedPartCount(), error: `Bad frame: ${(e as Error).message}` } }
    if (this.d.isError()) return { done: false, progress: 0, expected: 0, error: this.d.resultError() }
    if (!this.d.isComplete()) return { done: false, progress: this.progress(), expected: this.d.expectedPartCount() }
    const ur = this.d.resultUR()
    const bytes = new Uint8Array(ur.decodeCBOR())
    return { done: true, progress: 1, expected: this.d.expectedPartCount(), psbt: bytesToB64(psbtBytes(bytesToB64(bytes))) }
  }
  progress() { return this.d.estimatedPercentComplete() }
}
