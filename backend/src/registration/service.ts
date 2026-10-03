import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WalletService } from '../wallets.js';
import type { DeviceService } from '../devices.js';
import { HttpError } from '../errors.js';
import { coldcardMultisigFile, coldcardName, parseColdcardMultisig } from './coldcard.js';
import { MockLedger, policyId, walletPolicyFor, type LedgerDevice, type WalletPolicy } from './ledger.js';

export interface Registration {
  cosigner: number; fingerprint: string; device: 'ledger' | 'coldcard'; mock: boolean; at: string;
  policy?: WalletPolicy; policyId?: string; hmac?: string; // Ledger
  fileSha256?: string; name?: string;                      // Coldcard
}

/** Multisig registration on signing devices so they can verify change and display the wallet. Public data only. */
export class RegistrationService {
  private file: string;
  constructor(private wallets: WalletService, private devices: DeviceService, opts: { dataDir: string; network: string; ledger?: (fingerprint: string) => LedgerDevice }) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, `registrations.${opts.network}.json`);
    this.ledger = opts.ledger ?? ((fp) => new MockLedger(fp));
  }
  private ledger: (fp: string) => LedgerDevice;
  private read(): Record<string, Registration[]> { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; }
  private write(all: Record<string, Registration[]>) { writeFileSync(`${this.file}.tmp`, JSON.stringify(all, null, 2)); renameSync(`${this.file}.tmp`, this.file); }
  private save(walletId: string, r: Registration) {
    const all = this.read();
    all[walletId] = [...(all[walletId] ?? []).filter((x) => !(x.cosigner === r.cosigner && x.device === r.device)), r];
    this.write(all);
  }
  private wallet(id: string) {
    const w = this.wallets.get(id);
    if (w.type !== 'multisig' && w.type !== 'watchonly') throw new HttpError(400, 'Registration applies to multisig wallets');
    return w;
  }

  async status(walletId: string) {
    const w = this.wallet(walletId);
    const regs = this.read()[walletId] ?? [];
    const connected = this.devices.available ? await this.devices.list().catch(() => []) : [];
    const policy = walletPolicyFor(w);
    return {
      walletId, name: w.name, coldcardName: coldcardName(w.name), policy, policyId: policyId(policy),
      hwi: { register: false, note: 'HWI 3.2.0 has no register command; Ledger registration runs through the adapter below (mock here), Coldcard via setup file.' },
      cosigners: w.cosigners.map((c, i) => {
        const type = c.device?.type ?? null;
        const conn = connected.find((d) => d.fingerprint === c.fingerprint) ?? null;
        return {
          cosigner: i, label: c.label, fingerprint: c.fingerprint, kind: c.kind ?? 'software', deviceType: type,
          connected: conn ? { type: conn.type, model: conn.model, path: conn.path } : null,
          trezor: type === 'trezor' ? { required: false, reason: 'Trezor keeps no wallet state: it checks the multisig inputs/outputs against the xpubs inside each PSBT and shows the co-signer xpubs when displaying an address. Use "Verify address on device" instead.' } : null,
          registrations: regs.filter((r) => r.cosigner === i).map((r) => ({ ...r, valid: r.device === 'ledger' ? r.policyId === policyId(policy) : true })),
        };
      }),
    };
  }

  coldcard(walletId: string) {
    const w = this.wallet(walletId);
    const text = coldcardMultisigFile(w);
    const parsed = parseColdcardMultisig(text); // self-check with the firmware rules before handing it out
    return { text, sha256: createHash('sha256').update(text).digest('hex'), filename: `${parsed.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-coldcard.txt`, parsed };
  }
  /** User confirms the Coldcard showed the right wallet and they approved the import. */
  confirmColdcard(walletId: string, cosigner: number) {
    const w = this.wallet(walletId);
    const c = w.cosigners[cosigner];
    if (!c) throw new HttpError(404, 'No such cosigner');
    const f = this.coldcard(walletId);
    const r: Registration = { cosigner, fingerprint: c.fingerprint, device: 'coldcard', mock: false, at: new Date().toISOString(), fileSha256: f.sha256, name: f.parsed.name };
    this.save(walletId, r);
    return r;
  }

  async registerLedger(walletId: string, cosigner: number) {
    const w = this.wallet(walletId);
    const c = w.cosigners[cosigner];
    if (!c) throw new HttpError(404, 'No such cosigner');
    if (c.device?.type === 'trezor') throw new HttpError(400, 'This cosigner is a Trezor: no registration needed');
    const dev = this.ledger(c.fingerprint);
    const policy = walletPolicyFor(w);
    let out: { policyId: string; hmac: string };
    try { out = await dev.registerWallet(policy); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (out.policyId !== policyId(policy)) throw new HttpError(502, 'Device returned a different wallet id than computed locally');
    const r: Registration = { cosigner, fingerprint: c.fingerprint, device: 'ledger', mock: dev.mock, at: new Date().toISOString(), policy, policyId: out.policyId, hmac: out.hmac };
    this.save(walletId, r);
    return r;
  }
  /** Re-derive the policy from the current wallet and check the stored HMAC still authenticates it. */
  verifyLedger(walletId: string, cosigner: number) {
    const w = this.wallet(walletId);
    const r = (this.read()[walletId] ?? []).find((x) => x.cosigner === cosigner && x.device === 'ledger');
    if (!r) throw new HttpError(404, 'Not registered');
    const policy = walletPolicyFor(w);
    const sameId = policyId(policy) === r.policyId;
    return { policyId: r.policyId, sameId, hmacValid: sameId && this.ledger(r.fingerprint).verifyHmac(policy, r.hmac!) };
  }
}
