/**
 * Client-side Bitcoin signed-message verification (Bitcoin Core `signmessage` / BIP-137 legacy P2PKH),
 * using the audited noble/scure libraries, so trustee badges do not depend only on the server's `verifymessage`.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { base58check, base64 } from '@scure/base'
import { attestationStatement } from '../../../shared/msgcrypto'

const b58c = base58check(sha256)
const enc = new TextEncoder()
const MAGIC = 'Bitcoin Signed Message:\n'
const P2PKH_VERSION: Record<number, string> = { 0x00: 'main', 0x6f: 'test/regtest' }

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff)
}
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length } return o }

/** Double-SHA256 of the Bitcoin message envelope. */
export function messageHash(message: string): Uint8Array {
  const m = enc.encode(message), p = enc.encode(MAGIC)
  return sha256(sha256(concat(varint(p.length), p, varint(m.length), m)))
}

export type MsgVerify = { ok: true; address: string; network: string } | { ok: false; reason: string }

/** Verify a base64 compact signature against a legacy P2PKH address. */
export function verifyMessage(address: string, signatureB64: string, message: string): MsgVerify {
  let sig: Uint8Array, addr: Uint8Array
  try { sig = base64.decode(String(signatureB64).trim()) } catch { return { ok: false, reason: 'signature is not base64' } }
  if (sig.length !== 65) return { ok: false, reason: `signature must be 65 bytes, got ${sig.length}` }
  try { addr = b58c.decode(address) } catch { return { ok: false, reason: 'address is not a valid base58check P2PKH address' } }
  if (addr.length !== 21 || !(addr[0] in P2PKH_VERSION)) return { ok: false, reason: 'only legacy P2PKH addresses are supported' }
  const header = sig[0]
  if (header < 27 || header > 34) return { ok: false, reason: `unsupported signature header ${header} (expected P2PKH 27–34)` }
  const compressed = header >= 31
  const recovered = concat(Uint8Array.of((header - 27) & 3), sig.slice(1))
  let pub: Uint8Array
  try { pub = secp256k1.recoverPublicKey(recovered, messageHash(message), { prehash: false }) } catch { return { ok: false, reason: 'public key recovery failed' } }
  if (!compressed) pub = secp256k1.Point.fromBytes(pub).toBytes(false)
  const h160 = ripemd160(sha256(pub))
  const match = h160.every((b, i) => b === addr[i + 1])
  return match ? { ok: true, address, network: P2PKH_VERSION[addr[0]] } : { ok: false, reason: 'signature was made by a different key' }
}

export interface AttestedIdentity { fingerprint: string; label: string; signPub: string; boxPub: string; issuedAt: string; statement: string; btcAddress: string; btcSignature: string }

/**
 * Re-check a trustee attestation in the browser: (1) the statement really binds these Ed25519/X25519 keys to this
 * wallet + cosigner, and (2) the cosigner's Bitcoin key signed exactly that statement.
 */
export function verifyAttestation(walletId: string, id: AttestedIdentity): MsgVerify {
  const expected = attestationStatement({ walletId, fingerprint: id.fingerprint, label: id.label, signPub: id.signPub, boxPub: id.boxPub, issuedAt: id.issuedAt })
  if (expected !== id.statement) return { ok: false, reason: 'statement does not match the listed keys' }
  return verifyMessage(id.btcAddress, id.btcSignature, id.statement)
}
