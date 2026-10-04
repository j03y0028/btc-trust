import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type WalletType = 'multisig' | 'singlesig' | 'watchonly';

export type SignerKind = 'software' | 'hardware' | 'airgapped';

export interface Cosigner {
  label: string;
  /** software = bitcoind wallet on this node; hardware = HWI device; airgapped = external xpub, signs via PSBT file/QR. */
  kind?: SignerKind;
  device?: { type: string; model: string; label: string | null };
  /** Fingerprint of the cosigner master key (from the key origin). */
  fingerprint: string;
  /** Public key expression, e.g. [fp/84h/1h/0h]tpub.../0/* (never private). */
  key: string;
  /** bitcoind wallet holding the private key, if this cosigner lives on this node. */
  signerWallet?: string;
}

export interface WalletConfig {
  id: string;
  name: string;
  type: WalletType;
  network: string;
  /** Signatures required (m) and total keys (n). Single-sig = 1/1, watch-only = 0 local signers. */
  m: number;
  n: number;
  /** bitcoind wallet that tracks the descriptor (watch-only for multisig). */
  watchWallet: string;
  descriptors: { receive: string; change?: string };
  cosigners: Cosigner[];
  createdAt: string;
}

/** JSON-file store holding per-wallet config. Contains only public data. */
export class WalletStore {
  private file: string;
  constructor(dataDir: string, network: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, `wallets.${network}.json`);
  }
  list(): WalletConfig[] {
    if (!existsSync(this.file)) return [];
    return JSON.parse(readFileSync(this.file, 'utf8')) as WalletConfig[];
  }
  get(id: string): WalletConfig | undefined {
    return this.list().find((w) => w.id === id);
  }
  save(w: WalletConfig) {
    const all = this.list().filter((x) => x.id !== w.id);
    all.push(w);
    this.write(all);
  }
  /** Replace an existing entry in place (keeps list order). */
  update(w: WalletConfig) {
    const all = this.list();
    const i = all.findIndex((x) => x.id === w.id);
    if (i < 0) throw new Error(`wallet ${w.id} not in store`);
    all[i] = w;
    this.write(all);
  }
  remove(id: string): boolean {
    const all = this.list();
    const rest = all.filter((x) => x.id !== id);
    if (rest.length === all.length) return false;
    this.write(rest);
    return true;
  }
  private write(all: WalletConfig[]) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.file);
  }
}
