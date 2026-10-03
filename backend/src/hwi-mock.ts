import type { BitcoinRpc } from './rpc.js';
import type { HwDevice, HwiAdapter } from './hwi.js';

/**
 * MOCK hardware wallet for tests/CI where neither a device nor an emulator is available.
 * The "device" keys live in a dedicated bitcoind regtest wallet; signing goes through walletprocesspsbt.
 * Limitation: xpubs are always the wallet's BIP84 account key (m/84h/1h/0h), whatever path was requested;
 * the returned path reflects that so descriptors stay correct.
 */
export class MockHwiAdapter implements HwiAdapter {
  readonly mode = 'mock' as const;
  connected = true;
  private fp: string | null = null;
  private key: { xpub: string; path: string } | null = null;

  constructor(private rpc: BitcoinRpc, private walletName = 'btctrust-mock-device', private label = 'Mock Signer') {}

  private async ensure() {
    if (this.fp) return;
    const loaded = await this.rpc.call<string[]>('listwallets');
    if (!loaded.includes(this.walletName)) {
      try {
        await this.rpc.call('loadwallet', [this.walletName]);
      } catch {
        await this.rpc.call('createwallet', { wallet_name: this.walletName });
      }
    }
    const { descriptors } = await this.rpc.call<{ descriptors: { desc: string; internal: boolean }[] }>('listdescriptors', [false], this.walletName);
    const d = descriptors.find((x) => x.desc.startsWith('wpkh(') && !x.internal)!;
    const m = d.desc.match(/^wpkh\(\[([0-9a-f]{8})\/([^\]]+)\]([tx]pub[1-9A-HJ-NP-Za-km-z]+)\/0\/\*\)/)!;
    this.fp = m[1];
    this.key = { xpub: m[3], path: `m/${m[2]}` };
  }

  async version() {
    return 'mock-1.0';
  }

  async enumerate(): Promise<HwDevice[]> {
    if (!this.connected) return [];
    await this.ensure();
    return [{ type: 'mock', model: 'mock_device', path: `mock:${this.walletName}`, label: this.label, fingerprint: this.fp, needsPin: false, needsPassphrase: false, error: null, emulator: true }];
  }

  async getXpub(_dev: HwDevice, _path: string) {
    await this.ensure();
    return this.key!;
  }

  async displayAddress(_dev: HwDevice, descriptor: string) {
    const info = await this.rpc.call<{ descriptor: string }>('getdescriptorinfo', [descriptor]);
    const [address] = await this.rpc.call<string[]>('deriveaddresses', [info.descriptor]);
    return address;
  }

  async signPsbt(_dev: HwDevice, psbt: string) {
    if (!this.connected) throw new Error('mock device disconnected');
    const r = await this.rpc.call<{ psbt: string }>('walletprocesspsbt', { psbt, sign: true, sighashtype: 'ALL', bip32derivs: true, finalize: false }, this.walletName);
    return r.psbt;
  }
}
