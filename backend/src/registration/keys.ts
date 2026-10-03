import { sha256 } from '@noble/hashes/sha2.js';
import { base58check } from '@scure/base';

const b58c = base58check(sha256);
/** BIP32 extended public key version bytes. */
export const XPUB_VERSIONS: Record<string, 'main' | 'test'> = { '0488b21e': 'main', '043587cf': 'test' };

export interface KeyOrigin { fingerprint: string; path: string[]; xpub: string; hardenedMark: 'h' | "'" }

/** Parse "[fp/48h/1h/0h/2h]tpub…/0/*" (descriptor key with origin) into its parts; children suffix is dropped. */
export function parseKeyOrigin(key: string): KeyOrigin {
  const m = /^\[([0-9a-fA-F]{8})((?:\/\d+['h]?)*)\]([1-9A-HJ-NP-Za-km-z]+)(\/.*)?$/.exec(key.trim());
  if (!m) throw new Error(`Key needs an origin [fingerprint/path]xpub: ${key.slice(0, 30)}…`);
  const path = m[2].split('/').filter(Boolean);
  return { fingerprint: m[1].toLowerCase(), path, xpub: m[3], hardenedMark: m[2].includes("'") ? "'" : 'h' };
}

/** Validate an xpub's base58check checksum, version and depth. */
export function inspectXpub(xpub: string) {
  let raw: Uint8Array;
  try { raw = b58c.decode(xpub); } catch { throw new Error(`Invalid xpub checksum: ${xpub.slice(0, 12)}…`); }
  if (raw.length !== 78) throw new Error('xpub must decode to 78 bytes');
  const version = Buffer.from(raw.subarray(0, 4)).toString('hex');
  const network = XPUB_VERSIONS[version];
  if (!network) throw new Error(`Unsupported xpub version ${version} (use xpub/tpub)`);
  return { network, depth: raw[4], parentFingerprint: Buffer.from(raw.subarray(5, 9)).toString('hex') };
}

export const pathString = (path: string[], mark: 'h' | "'" = 'h') => `m${path.map((p) => `/${p.replace(/['h]$/, mark)}`).join('')}`;

/** Wallet descriptor must be wsh(sortedmulti(m, k1/0/*, …)); returns m and the keys. */
export function parseSortedMulti(desc: string) {
  const d = desc.replace(/#[0-9a-z]{8}$/, '');
  const m = /^wsh\(sortedmulti\((\d+),(.+)\)\)$/.exec(d);
  if (!m) throw new Error('Only wsh(sortedmulti(…)) P2WSH multisig can be registered (BIP-67 sorted keys)');
  return { m: Number(m[1]), keys: m[2].split(',') };
}
