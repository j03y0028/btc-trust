// Test helper: produce real Bitcoin signed-message (BIP-137, compressed P2PKH) attestations with noble.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { base58check, base64 } from '@scure/base'
import { messageHash } from './lib/btcmessage'
import { attestationStatement } from '../../shared/msgcrypto'

export function testKey(seed: number) {
  const sk = sha256(new TextEncoder().encode(`btctrust-test-key-${seed}`))
  const pub = secp256k1.getPublicKey(sk, true)
  const h = ripemd160(sha256(pub))
  return { sk, address: base58check(sha256).encode(Uint8Array.from([0x6f, ...h])) }
}
export function signMessage(sk: Uint8Array, message: string) {
  const rec = secp256k1.sign(messageHash(message), sk, { prehash: false, format: 'recovered' })
  return base64.encode(Uint8Array.from([31 + rec[0], ...rec.slice(1)]))
}
export function attest(walletId: string, a: { fingerprint: string; label: string; signPub: string; boxPub: string }, seed: number, issuedAt = '2026-10-02T12:00:00.000Z') {
  const k = testKey(seed)
  const statement = attestationStatement({ walletId, ...a, issuedAt })
  return { issuedAt, statement, btcAddress: k.address, btcSignature: signMessage(k.sk, statement) }
}
