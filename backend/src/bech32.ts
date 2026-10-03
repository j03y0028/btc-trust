// Minimal BIP-173/350 decoder, used to compare an address shown by a device (which may use the tb1 HRP on regtest)
// with the address bitcoind derives (bcrt1). Only the witness version + program are compared.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data: number[], from: number, to: number) {
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); }
  }
  if (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1))) return null;
  return out;
}

export function decodeSegwit(address: string): { hrp: string; version: number; program: string } | null {
  const a = address.toLowerCase();
  const pos = a.lastIndexOf('1');
  if (pos < 1 || pos + 7 > a.length) return null;
  const hrp = a.slice(0, pos);
  const data = [...a.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return null;
  const check = polymod([...hrpExpand(hrp), ...data]);
  const version = data[0];
  if (!((version === 0 && check === 1) || (version > 0 && check === 0x2bc830a3))) return null;
  const prog = convertBits(data.slice(1, -6), 5, 8);
  if (!prog || prog.length < 2 || prog.length > 40) return null;
  return { hrp, version, program: Buffer.from(prog).toString('hex') };
}

/** True when two segwit addresses encode the same witness program (HRP may differ, e.g. tb1 vs bcrt1). */
export function sameWitnessProgram(a: string, b: string) {
  const x = decodeSegwit(a), y = decodeSegwit(b);
  return !!x && !!y && x.version === y.version && x.program === y.program;
}
