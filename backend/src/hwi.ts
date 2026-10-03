import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { HttpError } from './errors.js';

export interface HwDevice {
  type: string;
  model: string;
  path: string;
  label: string | null;
  fingerprint: string | null;
  needsPin: boolean;
  needsPassphrase: boolean;
  error: string | null;
  emulator: boolean;
}

/** Abstraction over HWI so tests/CI can use a mock and production can use the real `hwi` binary. */
export interface HwiAdapter {
  readonly mode: 'hwi' | 'mock';
  version(): Promise<string>;
  enumerate(): Promise<HwDevice[]>;
  /** Returns the xpub and the derivation path it was actually derived at. */
  getXpub(dev: HwDevice, path: string): Promise<{ xpub: string; path: string }>;
  displayAddress(dev: HwDevice, descriptor: string): Promise<string>;
  /** Returns the PSBT with the device's signatures added (not finalized). */
  signPsbt(dev: HwDevice, psbt: string): Promise<string>;
}

const CHAIN: Record<string, string> = { regtest: 'regtest', signet: 'signet', testnet: 'test', testnet4: 'testnet4', main: 'main' };

export class HwiCliAdapter implements HwiAdapter {
  readonly mode = 'hwi' as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private opts: { bin: string; network: string; emulators: boolean; timeoutMs: number }) {}

  static available(bin: string) {
    return existsSync(bin);
  }

  /** Serialize HWI calls: devices handle one request at a time. */
  private run<T>(args: string[], dev?: HwDevice): Promise<T> {
    const full = [
      '--chain', CHAIN[this.opts.network] ?? 'regtest',
      ...(this.opts.emulators ? ['--emulators'] : []),
      ...(dev ? ['-t', dev.type, '-d', dev.path] : []),
      ...args,
    ];
    const job = this.queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          execFile(this.opts.bin, full, { timeout: this.opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = stdout?.toString().trim();
            if (out) {
              try {
                const j = JSON.parse(out);
                if (j && typeof j === 'object' && !Array.isArray(j) && 'error' in j) {
                  return reject(new HttpError(j.code === -13 ? 409 : 502, `Device error: ${j.error}`, { code: j.code }));
                }
                return resolve(j as T);
              } catch {
                /* fall through */
              }
            }
            if (err) {
              const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
              return reject(new HttpError(timedOut ? 504 : 502, timedOut ? 'Hardware wallet did not respond in time (confirm on the device?)' : `HWI failed: ${stderr?.toString().trim() || err.message}`));
            }
            resolve(out as unknown as T);
          });
        }),
    );
    this.queue = job.catch(() => {});
    return job;
  }

  async version() {
    const v = await this.run<string>(['--version']);
    return String(v).replace(/^hwi\s*/, '');
  }

  async enumerate(): Promise<HwDevice[]> {
    const list = await this.run<Record<string, unknown>[]>(['enumerate']);
    return list.map((d) => ({
      type: String(d.type),
      model: String(d.model ?? d.type),
      path: String(d.path),
      label: (d.label as string) ?? null,
      fingerprint: (d.fingerprint as string) ?? null,
      needsPin: !!d.needs_pin_sent,
      needsPassphrase: !!d.needs_passphrase_sent,
      error: (d.error as string) ?? null,
      emulator: /simulator|emulator/i.test(String(d.model)) || String(d.path).startsWith('udp:') || String(d.path).startsWith('tcp:'),
    }));
  }

  async getXpub(dev: HwDevice, path: string) {
    const r = await this.run<{ xpub: string }>(['getxpub', path], dev);
    return { xpub: r.xpub, path };
  }

  async displayAddress(dev: HwDevice, descriptor: string) {
    const r = await this.run<{ address: string }>(['displayaddress', '--desc', descriptor], dev);
    return r.address;
  }

  async signPsbt(dev: HwDevice, psbt: string) {
    const r = await this.run<{ psbt: string; signed?: boolean }>(['signtx', psbt], dev);
    return r.psbt;
  }
}
