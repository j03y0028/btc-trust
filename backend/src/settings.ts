/** App-wide display preferences (one app login = one user), saved in <dataDir>/settings.json. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './errors.js';
import { isCurrency, type Currency } from './prices.js';

export type BtcUnit = 'BTC' | 'sats';
export interface DisplayPrefs { unit: BtcUnit; fiat: Currency | null }
export const DEFAULT_DISPLAY: DisplayPrefs = { unit: 'BTC', fiat: 'USD' };

export class SettingsStore {
  private file: string;
  constructor(dataDir: string) { this.file = join(dataDir, 'settings.json'); }

  private read(): { display?: Partial<DisplayPrefs> } {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; } catch { return {}; }
  }

  display(): DisplayPrefs {
    const d = this.read().display ?? {};
    return {
      unit: d.unit === 'sats' || d.unit === 'BTC' ? d.unit : DEFAULT_DISPLAY.unit,
      fiat: d.fiat === null ? null : isCurrency(d.fiat) ? d.fiat : DEFAULT_DISPLAY.fiat,
    };
  }

  setDisplay(body: unknown): DisplayPrefs {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected {unit?, fiat?}');
    const b = body as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => k !== 'unit' && k !== 'fiat');
    if (extra.length) throw new HttpError(400, `Unknown field(s): ${extra.join(', ')}`);
    const next = this.display();
    if ('unit' in b) {
      if (b.unit !== 'BTC' && b.unit !== 'sats') throw new HttpError(400, 'unit must be "BTC" or "sats"');
      next.unit = b.unit;
    }
    if ('fiat' in b) {
      if (b.fiat !== null && !isCurrency(b.fiat)) throw new HttpError(400, 'fiat must be a supported currency code or null');
      next.fiat = b.fiat;
    }
    const all = this.read();
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...all, display: next }, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    return next;
  }
}
