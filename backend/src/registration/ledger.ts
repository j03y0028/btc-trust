import { createHash, createHmac } from 'node:crypto';
import type { WalletConfig } from '../store.js';
import { parseKeyOrigin, parseSortedMulti, pathString } from './keys.js';

/** BIP-388 wallet policy as registered on the Ledger Bitcoin app (v2.1+). */
export interface WalletPolicy { name: string; template: string; keys: string[] }
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const varint = (n: number) => (n < 0xfd ? Buffer.of(n) : Buffer.from([0xfd, n & 0xff, n >> 8]));

export function walletPolicyFor(w: WalletConfig): WalletPolicy {
  const { m, keys } = parseSortedMulti(w.descriptors.receive);
  const name = w.name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
  return {
    name,
    template: `wsh(sortedmulti(${m},${keys.map((_, i) => `@${i}/**`).join(',')}))`,
    keys: keys.map((k) => { const o = parseKeyOrigin(k); return `[${o.fingerprint}${pathString(o.path, "'").slice(1)}]${o.xpub}`; }),
  };
}

/** Merkle root over key-info strings exactly as the Ledger app computes it (leaf = H(0x00‖e), node = H(0x01‖l‖r)). */
function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return Buffer.alloc(32);
  if (leaves.length === 1) return leaves[0];
  const n = leaves.length;
  const left = (n & (n - 1)) === 0 ? n / 2 : 1 << Math.floor(Math.log2(n));
  return sha(Buffer.concat([Buffer.of(1), merkleRoot(leaves.slice(0, left)), merkleRoot(leaves.slice(left))]));
}

/** Serialized wallet policy v2 and its id (sha256), matching ledger_bitcoin.WalletPolicy. */
export function serializePolicy(p: WalletPolicy): Buffer {
  const name = Buffer.from(p.name, 'ascii');
  if (name.length > 64) throw new Error('wallet name too long (max 64)');
  const tpl = Buffer.from(p.template, 'ascii');
  return Buffer.concat([Buffer.of(2), Buffer.of(name.length), name, varint(tpl.length), sha(tpl), varint(p.keys.length),
    merkleRoot(p.keys.map((k) => sha(Buffer.concat([Buffer.of(0), Buffer.from(k, 'ascii')]))))]);
}
export const policyId = (p: WalletPolicy) => sha(serializePolicy(p)).toString('hex');

/** What a Ledger transport must provide. HWI 3.2.0 has no `register` command, so only the mock implements it here. */
export interface LedgerDevice { readonly mock: boolean; fingerprint: string; registerWallet(p: WalletPolicy): Promise<{ policyId: string; hmac: string }>; verifyHmac(p: WalletPolicy, hmac: string): boolean }

/**
 * Behavioural mock of the Ledger Bitcoin app's REGISTER_WALLET: checks the policy is well-formed and contains this
 * device's key, then returns HMAC-SHA256(device secret, wallet id), the same construction the app uses
 * (secret derived on-device via SLIP-21 "LEDGER-Wallet policy"). Not a substitute for testing on a real device.
 */
export class MockLedger implements LedgerDevice {
  readonly mock = true;
  private secret: Buffer;
  constructor(public fingerprint: string, seed = 'btc-trust mock ledger') { this.secret = sha(Buffer.from(`${seed}:${fingerprint}:LEDGER-Wallet policy`)); }
  async registerWallet(p: WalletPolicy) {
    if (!/^wsh\(sortedmulti\(\d+,(@\d+\/\*\*,?)+\)\)$/.test(p.template)) throw new Error('Ledger mock: unsupported policy template');
    if (!p.keys.some((k) => k.startsWith(`[${this.fingerprint}/`))) throw new Error(`Ledger mock: none of the policy keys belongs to this device (${this.fingerprint})`);
    if (!p.name || p.name !== p.name.trim()) throw new Error('Ledger mock: wallet name must be non-empty without surrounding spaces');
    const id = policyId(p);
    return { policyId: id, hmac: createHmac('sha256', this.secret).update(Buffer.from(id, 'hex')).digest('hex') };
  }
  verifyHmac(p: WalletPolicy, hmac: string) {
    return createHmac('sha256', this.secret).update(Buffer.from(policyId(p), 'hex')).digest('hex') === hmac;
  }
}
