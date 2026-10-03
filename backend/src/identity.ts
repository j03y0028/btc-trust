import type { BitcoinRpc } from './rpc.js';
import type { WalletService } from './wallets.js';
import { kindOf } from './wallets.js';
import type { DeviceService } from './devices.js';
import { HttpError } from './errors.js';

/** A cosigner's signmessage identity key: legacy P2PKH at m/44h/<coin>h/0h/0/0 of the same seed (same master fingerprint). */
export interface IdentityKey { cosigner: number; label: string; kind: string; fingerprint: string; address: string; path: string }

export class IdentityKeys {
  constructor(private rpc: BitcoinRpc, private wallets: WalletService, private devices: DeviceService | undefined, private network: string) {}

  async resolve(walletId: string, spec: { cosigner?: number; address?: string }): Promise<IdentityKey> {
    const w = this.wallets.get(walletId);
    const i = Number(spec.cosigner ?? 0);
    const c = w.cosigners[i];
    if (!c) throw new HttpError(400, `No cosigner at index ${i}`);
    const coin = this.network === 'main' ? 0 : 1;
    const kind = kindOf(c);
    let address: string;
    let path = `m/44h/${coin}h/0h/0/0`;
    if (kind === 'software') {
      const { descriptors } = await this.rpc.call<{ descriptors: { desc: string; internal: boolean }[] }>('listdescriptors', [false], c.signerWallet!);
      const pkh = descriptors.find((d) => d.desc.startsWith('pkh(') && !d.internal);
      if (!pkh) throw new HttpError(500, 'Cosigner wallet has no pkh identity key');
      [address] = await this.rpc.call<string[]>('deriveaddresses', [pkh.desc, [0, 0]]);
      path = `m/${pkh.desc.match(/^pkh\(\[[0-9a-f]{8}\/([^\]]+)\]/)![1]}/0/0`;
    } else if (kind === 'hardware') {
      if (!this.devices) throw new HttpError(503, 'HWI is not configured');
      const xpub = await this.devices.rawXpub(c.fingerprint, `m/44h/${coin}h/0h`);
      const info = await this.rpc.call<{ descriptor: string }>('getdescriptorinfo', [`pkh(${xpub.xpub}/0/0)`]);
      [address] = await this.rpc.call<string[]>('deriveaddresses', [info.descriptor]);
      path = `${xpub.path}/0/0`;
    } else {
      if (!spec.address) throw new HttpError(400, 'Air-gapped cosigners need a P2PKH address that you can sign messages with');
      address = String(spec.address).trim();
      path = 'external';
    }
    const v = await this.rpc.call<{ isvalid: boolean; isscript?: boolean; iswitness?: boolean }>('validateaddress', [address]);
    if (!v.isvalid || v.isscript || v.iswitness) throw new HttpError(400, 'Identity key must be a legacy P2PKH address (signmessage-compatible)');
    return { cosigner: i, label: c.label, kind, fingerprint: c.fingerprint, address, path };
  }

  /** Sign with a key this node controls (software cosigner) or a connected hardware wallet. */
  async sign(walletId: string, key: IdentityKey, message: string): Promise<{ signature: string; signer: 'node' | 'device' }> {
    const c = this.wallets.get(walletId).cosigners[key.cosigner];
    if (key.kind === 'software') return { signature: await this.rpc.call<string>('signmessage', [key.address, message], c.signerWallet!), signer: 'node' };
    if (key.kind === 'hardware') {
      if (!this.devices) throw new HttpError(503, 'HWI is not configured');
      return { signature: await this.devices.signMessage(key.fingerprint, message, key.path), signer: 'device' };
    }
    throw new HttpError(400, 'Sign with your external wallet (signmessage) and paste the signature');
  }

  async verify(address: string, signature: string, message: string): Promise<boolean> {
    try {
      return await this.rpc.call<boolean>('verifymessage', [address, String(signature ?? '').trim(), message]);
    } catch {
      return false;
    }
  }
}
