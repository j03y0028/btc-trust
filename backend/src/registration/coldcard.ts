import type { WalletConfig } from '../store.js';
import { inspectXpub, parseKeyOrigin, parseSortedMulti, pathString } from './keys.js';

/**
 * Coldcard multisig setup file ("simple text" format imported via Settings > Multisig Wallets > Import from File,
 * or scanned as QR on Coldcard Q). Format per Coldcard's multisig docs and firmware (shared/multisig.py):
 *   Name: ≤20 chars · Policy: M of N · Format: P2WSH · Derivation: <path> (applies to the following keys) · XFP: xpub
 */
export const COLDCARD_MAX_NAME = 20;
export const COLDCARD_MAX_SIGNERS = 15;

export const coldcardName = (name: string) => name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, COLDCARD_MAX_NAME).trim() || 'BTC Trust';

export function coldcardMultisigFile(w: WalletConfig, now = new Date()): string {
  if (w.type !== 'multisig' && w.type !== 'watchonly') throw new Error('Coldcard registration needs a multisig wallet');
  const { m, keys } = parseSortedMulti(w.descriptors.receive);
  if (keys.length > COLDCARD_MAX_SIGNERS) throw new Error(`Coldcard supports at most ${COLDCARD_MAX_SIGNERS} signers`);
  const lines = [
    '# Coldcard Multisig setup file (exported by BTC Trust)',
    `# Wallet: ${w.name} (${w.id}) · network: ${w.network}`,
    `# Exported: ${now.toISOString()}`,
    '# Import: Settings > Multisig Wallets > Import from File (SD card), or scan on Coldcard Q.',
    '# Verify every fingerprint and xpub on the device screen before approving.',
    '#',
    `Name: ${coldcardName(w.name)}`,
    `Policy: ${m} of ${keys.length}`,
    'Format: P2WSH',
  ];
  let lastPath = '';
  for (const k of keys) {
    const o = parseKeyOrigin(k);
    const x = inspectXpub(o.xpub);
    if (x.depth !== o.path.length) throw new Error(`xpub depth ${x.depth} does not match derivation ${pathString(o.path)}`);
    const path = pathString(o.path, 'h');
    if (path !== lastPath) { lines.push('', `Derivation: ${path}`); lastPath = path; }
    lines.push(`${o.fingerprint.toUpperCase()}: ${o.xpub}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ColdcardConfig { name: string; m: number; n: number; format: string; keys: { xfp: string; derivation: string; xpub: string }[] }

/** Strict parser applying the same rules the Coldcard firmware enforces on import. */
export function parseColdcardMultisig(text: string): ColdcardConfig {
  let name = '', m = 0, n = 0, format = 'P2SH', derivation = '';
  const keys: ColdcardConfig['keys'] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const c = line.indexOf(':');
    if (c < 0) throw new Error(`line ${i + 1}: expected "label: value"`);
    const label = line.slice(0, c).trim(), value = line.slice(c + 1).trim();
    switch (label.toLowerCase()) {
      case 'name':
        if (!value || value.length > COLDCARD_MAX_NAME || /[^\x20-\x7e]/.test(value)) throw new Error(`line ${i + 1}: name must be 1-${COLDCARD_MAX_NAME} printable ASCII chars`);
        name = value; break;
      case 'policy': {
        const p = /^(\d+)\s*(?:of|\/)\s*(\d+)$/i.exec(value);
        if (!p) throw new Error(`line ${i + 1}: policy must be "M of N"`);
        m = Number(p[1]); n = Number(p[2]); break;
      }
      case 'format':
        if (!['P2SH', 'P2SH-P2WSH', 'P2WSH-P2SH', 'P2WSH'].includes(value.toUpperCase())) throw new Error(`line ${i + 1}: unknown format ${value}`);
        format = value.toUpperCase(); break;
      case 'derivation':
        if (!/^m(\/\d+['hp]?)*$/.test(value)) throw new Error(`line ${i + 1}: bad derivation ${value}`);
        derivation = value; break;
      default:
        if (!/^[0-9a-fA-F]{8}$/.test(label)) throw new Error(`line ${i + 1}: unknown label ${label}`);
        if (!derivation) throw new Error(`line ${i + 1}: key before any Derivation line`);
        inspectXpub(value);
        if (keys.some((k) => k.xfp === label.toUpperCase())) throw new Error(`line ${i + 1}: duplicate XFP ${label}`);
        keys.push({ xfp: label.toUpperCase(), derivation, xpub: value });
    }
  }
  if (!name) throw new Error('missing Name');
  if (!(m >= 1 && m <= n && n <= COLDCARD_MAX_SIGNERS)) throw new Error(`bad policy ${m} of ${n}`);
  if (keys.length !== n) throw new Error(`policy says ${n} keys but file has ${keys.length}`);
  return { name, m, n, format, keys };
}

/** Rebuild the receive descriptor (without checksum) from a parsed setup file. */
export function coldcardToDescriptor(c: ColdcardConfig) {
  if (c.format !== 'P2WSH') throw new Error('only P2WSH supported');
  const keys = c.keys.map((k) => `[${k.xfp.toLowerCase()}${k.derivation.slice(1)}]${k.xpub}/0/*`);
  return `wsh(sortedmulti(${c.m},${keys.join(',')}))`;
}
