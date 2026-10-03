import { HttpError } from './errors.js';
import type { HwDevice, HwiAdapter } from './hwi.js';

export type KeyPurpose = 'multisig' | 'singlesig';

export class DeviceService {
  private cache: { at: number; devices: HwDevice[] } | null = null;

  constructor(private adapter: HwiAdapter | null, private network: string) {}

  get available() {
    return !!this.adapter;
  }

  async status() {
    if (!this.adapter) return { available: false, mode: 'off' as const, version: null };
    return { available: true, mode: this.adapter.mode, version: await this.adapter.version().catch(() => null) };
  }

  private need(): HwiAdapter {
    if (!this.adapter) throw new HttpError(503, 'HWI is not installed/configured (set HWI_PATH)');
    return this.adapter;
  }

  async list(fresh = false): Promise<HwDevice[]> {
    const a = this.need();
    if (!fresh && this.cache && Date.now() - this.cache.at < 2000) return this.cache.devices;
    const devices = await a.enumerate();
    this.cache = { at: Date.now(), devices };
    return devices;
  }

  invalidate() {
    this.cache = null;
  }

  /** Connected, usable device with the given master fingerprint, or null. */
  async find(fingerprint: string): Promise<HwDevice | null> {
    if (!this.adapter) return null;
    const devices = await this.list().catch(() => []);
    return devices.find((d) => d.fingerprint === fingerprint && !d.error) ?? null;
  }

  async get(fingerprint: string): Promise<HwDevice> {
    const d = await this.find(fingerprint);
    if (!d) throw new HttpError(409, `Hardware wallet ${fingerprint} is not connected`, { code: 'DEVICE_NOT_CONNECTED' });
    return d;
  }

  /** Standard paths: BIP48 (P2WSH) for multisig, BIP84 for single-sig. */
  pathFor(purpose: KeyPurpose, account = 0) {
    const coin = this.network === 'main' ? 0 : 1;
    if (!Number.isInteger(account) || account < 0 || account > 1000) throw new HttpError(400, 'account must be 0..1000');
    return purpose === 'multisig' ? `m/48h/${coin}h/${account}h/2h` : `m/84h/${coin}h/${account}h`;
  }

  async xpub(fingerprint: string, purpose: KeyPurpose, account = 0) {
    const dev = await this.get(fingerprint);
    const { xpub, path } = await this.need().getXpub(dev, this.pathFor(purpose, account));
    const origin = path.replace(/^m\//, '').replace(/'/g, 'h');
    return { fingerprint, path, xpub, key: `[${fingerprint}/${origin}]${xpub}/0/*`, device: { type: dev.type, model: dev.model, label: dev.label } };
  }

  async display(fingerprint: string, descriptor: string) {
    return this.need().displayAddress(await this.get(fingerprint), descriptor);
  }

  async sign(fingerprint: string, psbt: string) {
    return this.need().signPsbt(await this.get(fingerprint), psbt);
  }
}
