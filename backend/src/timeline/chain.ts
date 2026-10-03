import { createHash } from 'node:crypto';

/** Bitcoin consensus facts used by the timeline (mainnet). */
export const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
export const GENESIS_COINBASE_TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
export const HALVING_INTERVAL = 210_000;
export const HALVING_HEIGHTS = [210_000, 420_000, 630_000, 840_000] as const;
export const NEXT_HALVING = 1_050_000;
export const WHITEPAPER = {
  title: 'Bitcoin: A Peer-to-Peer Electronic Cash System',
  author: 'Satoshi Nakamoto',
  date: '2008-10-31',
  url: 'https://bitcoin.org/bitcoin.pdf',
  announcement: 'https://www.metzdowd.com/pipermail/cryptography/2008-October/014810.html',
  sha256: 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553',
  localPath: '/bitcoin.pdf',
};

const dsha = (b: Buffer) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rev = (b: Buffer) => Buffer.from(b).reverse().toString('hex');

export interface BlockHeader { hash: string; version: number; prevHash: string; merkleRoot: string; time: number; bits: number; nonce: number; difficulty: number; powValid: boolean }

/** Parse an 80-byte block header, compute its hash and check proof of work against its own `bits`. */
export function parseHeader(hex: string): BlockHeader {
  const b = Buffer.from(String(hex).trim(), 'hex');
  if (b.length !== 80) throw new Error(`Block header must be 80 bytes, got ${b.length}`);
  const bits = b.readUInt32LE(72);
  const exp = bits >>> 24;
  const mantissa = bits & 0xffffff;
  const target = BigInt(mantissa) * (1n << BigInt(8 * (exp - 3)));
  const hash = rev(dsha(b));
  return {
    hash, version: b.readInt32LE(0), prevHash: rev(b.subarray(4, 36)), merkleRoot: rev(b.subarray(36, 68)),
    time: b.readUInt32LE(68), bits, nonce: b.readUInt32LE(76),
    difficulty: (0xffff / mantissa) * 256 ** (0x1d - exp),
    powValid: BigInt(`0x${hash}`) <= target,
  };
}

function readVarInt(b: Buffer, o: number): [number, number] {
  const f = b[o];
  if (f < 0xfd) return [f, o + 1];
  if (f === 0xfd) return [b.readUInt16LE(o + 1), o + 3];
  if (f === 0xfe) return [b.readUInt32LE(o + 1), o + 5];
  return [Number(b.readBigUInt64LE(o + 1)), o + 9];
}

/** Extract data pushes from a script (handles direct pushes and PUSHDATA1/2). */
export function scriptPushes(script: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < script.length;) {
    const op = script[i++];
    let n = 0;
    if (op >= 1 && op <= 75) n = op;
    else if (op === 0x4c) n = script[i++];
    else if (op === 0x4d) { n = script.readUInt16LE(i); i += 2; }
    else continue;
    out.push(script.subarray(i, i + n));
    i += n;
  }
  return out;
}

/** Decode the genesis coinbase: txid, scriptSig pushes and the embedded newspaper headline. */
export function parseCoinbase(txHex: string) {
  const b = Buffer.from(String(txHex).trim(), 'hex');
  let o = 4;
  const [vin, o1] = readVarInt(b, o); o = o1;
  if (vin !== 1) throw new Error('Not a coinbase transaction');
  const prev = b.subarray(o, o + 36); o += 36;
  if (!prev.subarray(0, 32).equals(Buffer.alloc(32))) throw new Error('Input is not a coinbase');
  const [len, o2] = readVarInt(b, o); o = o2;
  const scriptSig = b.subarray(o, o + len);
  const texts = scriptPushes(scriptSig).map((p) => p.toString('latin1')).filter((s) => /^[\x20-\x7e]{10,}$/.test(s));
  return { txid: rev(dsha(b)), scriptSigHex: scriptSig.toString('hex'), headline: texts.sort((a, c) => c.length - a.length)[0] ?? null };
}

/** Verify a genesis block from its raw header and coinbase transaction. */
export function verifyGenesis(headerHex: string, coinbaseHex: string) {
  const h = parseHeader(headerHex);
  const cb = parseCoinbase(coinbaseHex);
  const checks = {
    hashIsGenesis: h.hash === GENESIS_HASH,
    proofOfWork: h.powValid,
    merkleRootIsCoinbase: h.merkleRoot === cb.txid, // single-transaction block
    coinbaseTxid: cb.txid === GENESIS_COINBASE_TXID,
  };
  return { ...h, coinbaseTxid: cb.txid, headline: cb.headline, scriptSigHex: cb.scriptSigHex, checks, verified: Object.values(checks).every(Boolean) };
}

/** Estimate when `target` height is reached from two observed (height, time) points. */
export function estimateHeightDate(target: number, from: { height: number; time: number }, to: { height: number; time: number }) {
  const blocks = to.height - from.height;
  const avg = blocks > 0 ? (to.time - from.time) / blocks : 600;
  const remaining = Math.max(0, target - to.height);
  return { target, remaining, avgBlockSeconds: avg, estimatedTime: Math.round(to.time + remaining * avg), naiveTime: Math.round(to.time + remaining * 600), basis: { from, to } };
}

export const halvingSubsidy = (height: number) => 50 / 2 ** Math.floor(height / HALVING_INTERVAL);

/** Whole days between two YYYY-MM-DD dates (calendar days, timezone-independent). */
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
