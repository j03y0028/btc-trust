import { randomBytes } from 'node:crypto';
import { BitcoinRpc, RpcError } from './rpc.js';
import { HttpError } from './errors.js';
import type { Cosigner, WalletConfig, WalletStore, WalletType } from './store.js';

export const MAX_KEYS = 15;
const PRIVATE_KEY_RE = /\b[tx]prv[1-9A-HJ-NP-Za-km-z]{20,}|\b[c59KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/;
const KEY_EXPR_RE = /(?:\[([0-9a-fA-F]{8})[^\]]*\])?([tx]pub[1-9A-HJ-NP-Za-km-z]{100,})[^,)]*/g;

export interface CreateWalletInput {
  name: string;
  type: WalletType;
  m?: number;
  n?: number;
  cosignerLabels?: string[];
  /** Optional external cosigner public keys for multisig (e.g. a hardware wallet xpub). */
  externalKeys?: string[];
  /** Watch-only: a full output descriptor ... */
  descriptor?: string;
  /** ... or a bare tpub/xpub (imported as wpkh). */
  xpub?: string;
  rescan?: boolean;
}

export interface PsbtOutput { address: string; amount: number; isChange: boolean }
export interface PsbtInfo {
  psbt: string;
  txid: string;
  fee: number | null;
  required: number;
  signatures: number;
  signedBy: string[];
  complete: boolean;
  inputs: number;
  outputs: PsbtOutput[];
}

interface DecodedPsbt {
  tx: { txid: string; vout: { value: number; scriptPubKey: { address?: string } }[] };
  inputs: { partial_signatures?: Record<string, string>; final_scriptwitness?: string[]; final_scriptSig?: unknown; bip32_derivs?: { pubkey: string; master_fingerprint: string }[] }[];
  outputs: { bip32_derivs?: unknown[] }[];
  fee?: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'wallet';
const stripChecksum = (d: string) => d.replace(/#[a-z0-9]{8}$/, '').trim();
const LETTERS = 'ABCDEFGHIJKLMNO';

export function assertNoPrivateKeys(text: string, what = 'input') {
  if (PRIVATE_KEY_RE.test(text)) throw new HttpError(400, `Private keys are not accepted in ${what}. Use public keys (tpub/xpub) only.`);
}

/** Parse m and the public keys out of a (sorted)multi descriptor. */
export function parseDescriptor(desc: string): { m: number; n: number; keys: { fingerprint: string; key: string }[] } {
  const keys = [...desc.matchAll(KEY_EXPR_RE)].map((k) => ({ fingerprint: (k[1] ?? '').toLowerCase(), key: k[0] }));
  const multi = desc.match(/(?:sorted)?multi(?:_a)?\((\d+),/);
  if (multi) return { m: Number(multi[1]), n: keys.length, keys };
  return { m: 1, n: Math.max(1, keys.length), keys };
}

export function validateMN(m: number, n: number) {
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || n < 1 || m > n || n > MAX_KEYS) {
    throw new HttpError(400, `Invalid multisig parameters: need 1 <= m <= n <= ${MAX_KEYS} (got ${m}-of-${n})`);
  }
}

/** Derive the change (/1/*) descriptor from a receive (/0/*) descriptor. */
export function changeVariant(desc: string): string | undefined {
  const base = stripChecksum(desc);
  return base.includes('/0/*') ? base.replaceAll('/0/*', '/1/*') : undefined;
}

export function summarizePsbt(psbt: string, d: DecodedPsbt, required: number): PsbtInfo {
  const perInput = d.inputs.map((i) => {
    if (i.final_scriptwitness || i.final_scriptSig) return { count: required, fps: null as Set<string> | null };
    const sigs = Object.keys(i.partial_signatures ?? {});
    const fps = new Set((i.bip32_derivs ?? []).filter((b) => sigs.includes(b.pubkey)).map((b) => b.master_fingerprint));
    return { count: sigs.length, fps };
  });
  const signatures = perInput.length ? Math.min(...perInput.map((p) => p.count)) : 0;
  const fpSets = perInput.map((p) => p.fps).filter((s): s is Set<string> => s !== null);
  const signedBy = fpSets.length ? [...fpSets[0]].filter((fp) => fpSets.every((s) => s.has(fp))) : [];
  return {
    psbt,
    txid: d.tx.txid,
    fee: d.fee ?? null,
    required,
    signatures: Math.min(signatures, required),
    signedBy,
    complete: signatures >= required && perInput.length > 0,
    inputs: d.inputs.length,
    outputs: d.tx.vout.map((v, i) => ({ address: v.scriptPubKey.address ?? '(non-standard)', amount: v.value, isChange: !!d.outputs[i]?.bip32_derivs?.length })),
  };
}

export class WalletService {
  constructor(private rpc: BitcoinRpc, private store: WalletStore, private network: string) {}

  /** Wallet RPC that transparently loads an unloaded wallet. */
  private async w<T>(wallet: string, method: string, params: unknown[] | Record<string, unknown> = []): Promise<T> {
    try {
      return await this.rpc.call<T>(method, params, wallet);
    } catch (e) {
      if (e instanceof RpcError && e.code === -18) {
        await this.rpc.call('loadwallet', [wallet]).catch(() => {});
        return this.rpc.call<T>(method, params, wallet);
      }
      throw e;
    }
  }

  private async checksum(desc: string) {
    try {
      return await this.rpc.call<{ descriptor: string; isrange: boolean; issolvable: boolean; hasprivatekeys: boolean }>('getdescriptorinfo', [stripChecksum(desc)]);
    } catch (e) {
      throw new HttpError(400, `Invalid descriptor: ${(e as Error).message}`);
    }
  }

  private async createSigner(walletName: string): Promise<{ fingerprint: string; key: string }> {
    await this.rpc.call('createwallet', { wallet_name: walletName, load_on_startup: true });
    const { descriptors } = await this.w<{ descriptors: { desc: string; internal: boolean; active: boolean }[] }>(walletName, 'listdescriptors', [false]);
    const d = descriptors.find((x) => x.desc.startsWith('wpkh(') && !x.internal && x.active);
    if (!d) throw new HttpError(500, 'Signer wallet has no wpkh descriptor');
    const key = d.desc.match(/^wpkh\((.*)\)#/)![1];
    return { fingerprint: key.match(/^\[([0-9a-f]{8})/)![1], key };
  }

  private normalizeExternalKey(k: string): string {
    const key = k.trim();
    assertNoPrivateKeys(key, 'cosigner keys');
    if (!/[tx]pub/.test(key)) throw new HttpError(400, `Not an extended public key: ${key.slice(0, 20)}…`);
    return /\/\*$/.test(key) ? key : `${key.replace(/\/$/, '')}/0/*`;
  }

  private async importInto(watchWallet: string, receive: string, change: string | undefined, timestamp: number | 'now') {
    const r = await this.checksum(receive);
    const reqs: Record<string, unknown>[] = [{ desc: r.descriptor, active: r.isrange, internal: false, timestamp, ...(r.isrange ? { range: [0, 999] } : {}) }];
    let changeDesc: string | undefined;
    if (change && r.isrange) {
      const c = await this.checksum(change);
      changeDesc = c.descriptor;
      reqs.push({ desc: c.descriptor, active: true, internal: true, timestamp, range: [0, 999] });
    }
    const res = await this.w<{ success: boolean; error?: { message: string } }[]>(watchWallet, 'importdescriptors', [reqs]);
    const bad = res.find((x) => !x.success);
    if (bad) throw new HttpError(400, `Descriptor import failed: ${bad.error?.message}`);
    return { receive: r.descriptor, change: changeDesc };
  }

  async create(input: CreateWalletInput): Promise<WalletConfig> {
    const name = (input.name ?? '').trim();
    if (!name || name.length > 64) throw new HttpError(400, 'Wallet name is required (max 64 chars)');
    assertNoPrivateKeys(JSON.stringify(input), 'wallet creation');
    const id = `${slug(name)}-${randomBytes(3).toString('hex')}`;
    const base = `btctrust-${id}`;
    const now = new Date().toISOString();
    const labels = input.cosignerLabels ?? [];

    if (input.type === 'multisig') {
      const m = input.m ?? 2, n = input.n ?? 3;
      validateMN(m, n);
      const external = (input.externalKeys ?? []).filter(Boolean).map((k) => this.normalizeExternalKey(k));
      if (external.length > n) throw new HttpError(400, 'More external keys than total keys');
      const cosigners: Cosigner[] = external.map((key, i) => ({
        label: labels[i] || `Cosigner ${LETTERS[i]} (external)`,
        fingerprint: (key.match(/^\[([0-9a-fA-F]{8})/)?.[1] ?? '00000000').toLowerCase(),
        key,
      }));
      for (let i = external.length; i < n; i++) {
        const signerWallet = `${base}-key${i + 1}`;
        const k = await this.createSigner(signerWallet);
        cosigners.push({ label: labels[i] || `Cosigner ${LETTERS[i]}`, ...k, signerWallet });
      }
      const receive = `wsh(sortedmulti(${m},${cosigners.map((c) => c.key).join(',')}))`;
      await this.rpc.call('createwallet', { wallet_name: base, disable_private_keys: true, blank: true, load_on_startup: true });
      const descriptors = await this.importInto(base, receive, changeVariant(receive), 'now');
      const cfg: WalletConfig = { id, name, type: 'multisig', network: this.network, m, n, watchWallet: base, descriptors, cosigners, createdAt: now };
      this.store.save(cfg);
      return cfg;
    }

    if (input.type === 'singlesig') {
      const k = await this.createSigner(base);
      const receive = (await this.checksum(`wpkh(${k.key})`)).descriptor;
      const change = (await this.checksum(changeVariant(receive)!)).descriptor;
      const cfg: WalletConfig = {
        id, name, type: 'singlesig', network: this.network, m: 1, n: 1, watchWallet: base,
        descriptors: { receive, change }, cosigners: [{ label: labels[0] || 'Hot key', ...k, signerWallet: base }], createdAt: now,
      };
      this.store.save(cfg);
      return cfg;
    }

    if (input.type === 'watchonly') {
      let receive: string;
      if (input.descriptor?.trim()) receive = stripChecksum(input.descriptor);
      else if (input.xpub?.trim()) receive = `wpkh(${this.normalizeExternalKey(input.xpub)})`;
      else throw new HttpError(400, 'Watch-only import needs a descriptor or an xpub');
      const info = await this.checksum(receive);
      if (info.hasprivatekeys) throw new HttpError(400, 'Descriptor contains private keys; watch-only import accepts public descriptors only');
      const parsed = parseDescriptor(receive);
      await this.rpc.call('createwallet', { wallet_name: base, disable_private_keys: true, blank: true, load_on_startup: true });
      const descriptors = await this.importInto(base, receive, changeVariant(receive), input.rescan === false ? 'now' : 0);
      const cfg: WalletConfig = {
        id, name, type: 'watchonly', network: this.network, m: parsed.m, n: parsed.n, watchWallet: base, descriptors,
        cosigners: parsed.keys.map((k, i) => ({ label: labels[i] || `Key ${LETTERS[i] ?? i + 1}`, ...k })), createdAt: now,
      };
      this.store.save(cfg);
      return cfg;
    }

    throw new HttpError(400, `Unknown wallet type: ${String(input.type)}`);
  }

  get(id: string): WalletConfig {
    const w = this.store.get(id);
    if (!w) throw new HttpError(404, `Wallet not found: ${id}`);
    return w;
  }

  private async balances(w: WalletConfig) {
    const b = await this.w<{ mine: { trusted: number; untrusted_pending: number; immature: number } }>(w.watchWallet, 'getbalances');
    return { confirmed: b.mine.trusted, pending: b.mine.untrusted_pending, immature: b.mine.immature, total: +(b.mine.trusted + b.mine.untrusted_pending).toFixed(8) };
  }

  async list() {
    return Promise.all(this.store.list().map(async (w) => ({ ...this.publicConfig(w), balance: await this.balances(w).catch(() => null) })));
  }

  publicConfig(w: WalletConfig) {
    return {
      ...w,
      cosigners: w.cosigners.map(({ signerWallet, ...c }) => ({ ...c, local: !!signerWallet })),
      canSign: w.cosigners.filter((c) => c.signerWallet).length >= w.m && w.m > 0,
    };
  }

  async details(id: string) {
    const w = this.get(id);
    const [balance, utxos, received, txs] = await Promise.all([
      this.balances(w),
      this.w<{ txid: string; vout: number; address: string; amount: number; confirmations: number }[]>(w.watchWallet, 'listunspent', [0]),
      this.w<{ address: string; amount: number; confirmations: number; txids: string[] }[]>(w.watchWallet, 'listreceivedbyaddress', [0, true, true]),
      this.w<{ txid: string; category: string; amount: number; fee?: number; confirmations: number; time: number; address?: string }[]>(w.watchWallet, 'listtransactions', ['*', 200, 0, true]),
    ]);
    const byTx = new Map<string, { txid: string; amount: number; fee: number; confirmations: number; time: number; categories: Set<string>; addresses: Set<string> }>();
    for (const t of txs) {
      const e = byTx.get(t.txid) ?? { txid: t.txid, amount: 0, fee: 0, confirmations: t.confirmations, time: t.time, categories: new Set(), addresses: new Set() };
      e.amount += t.amount;
      if (t.fee && !e.fee) e.fee = t.fee;
      e.categories.add(t.category);
      if (t.address) e.addresses.add(t.address);
      byTx.set(t.txid, e);
    }
    const history = [...byTx.values()]
      .map((e) => {
        const net = +(e.amount + e.fee).toFixed(8);
        const type = e.categories.has('generate') || e.categories.has('immature') ? 'mined' : net < 0 ? 'sent' : 'received';
        return { txid: e.txid, type, amount: net, fee: e.fee ? -e.fee : 0, confirmations: e.confirmations, time: e.time, addresses: [...e.addresses] };
      })
      .sort((a, b) => b.time - a.time || a.confirmations - b.confirmations);
    return {
      ...this.publicConfig(w),
      balance,
      utxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout, address: u.address, amount: u.amount, confirmations: u.confirmations })),
      addresses: received.map((r) => ({ address: r.address, received: r.amount, txCount: r.txids.length })),
      history,
    };
  }

  async newAddress(id: string) {
    const w = this.get(id);
    try {
      const address = await this.w<string>(w.watchWallet, 'getnewaddress', ['', 'bech32']);
      return { address };
    } catch (e) {
      if (!w.descriptors.change && w.type === 'watchonly') {
        const [address] = await this.rpc.call<string[]>('deriveaddresses', [w.descriptors.receive]);
        return { address };
      }
      throw e;
    }
  }

  private async info(w: WalletConfig, psbt: string): Promise<PsbtInfo> {
    let d: DecodedPsbt;
    try {
      d = await this.rpc.call<DecodedPsbt>('decodepsbt', [psbt]);
    } catch (e) {
      throw new HttpError(400, `Invalid PSBT: ${(e as Error).message}`);
    }
    return summarizePsbt(psbt, d, Math.max(1, w.m));
  }

  async createPsbt(id: string, body: { outputs: { address: string; amount: number }[]; feeRate?: number; subtractFee?: boolean }) {
    const w = this.get(id);
    const outs = body?.outputs ?? [];
    if (!Array.isArray(outs) || !outs.length) throw new HttpError(400, 'At least one output is required');
    for (const o of outs) {
      if (!(typeof o.amount === 'number' && o.amount > 0)) throw new HttpError(400, 'Amounts must be positive numbers (BTC)');
      const v = await this.rpc.call<{ isvalid: boolean }>('validateaddress', [o.address]);
      if (!v.isvalid) throw new HttpError(400, `Invalid ${this.network} address: ${o.address}`);
    }
    const options: Record<string, unknown> = { includeWatching: true };
    if (body.feeRate) options.fee_rate = body.feeRate;
    if (body.subtractFee) options.subtractFeeFromOutputs = outs.map((_, i) => i);
    const r = await this.w<{ psbt: string }>(w.watchWallet, 'walletcreatefundedpsbt', {
      inputs: [], outputs: outs.map((o) => ({ [o.address]: o.amount })), options, bip32derivs: true,
    });
    return this.info(w, r.psbt);
  }

  async decode(id: string, psbt: string) {
    return this.info(this.get(id), psbt);
  }

  async sign(id: string, psbt: string, cosignerIndex: number) {
    const w = this.get(id);
    const c = w.cosigners[cosignerIndex];
    if (!c) throw new HttpError(400, `No cosigner at index ${cosignerIndex}`);
    if (!c.signerWallet) throw new HttpError(400, `${c.label} is an external key; sign it on that device and import the PSBT`);
    const before = await this.info(w, psbt);
    if (before.signedBy.includes(c.fingerprint)) throw new HttpError(409, `${c.label} has already signed this PSBT`);
    const r = await this.w<{ psbt: string }>(c.signerWallet, 'walletprocesspsbt', { psbt, sign: true, sighashtype: 'ALL', bip32derivs: true, finalize: false });
    const after = await this.info(w, r.psbt);
    if (after.signatures <= before.signatures && !after.complete) throw new HttpError(422, `${c.label} could not sign this PSBT`);
    return after;
  }

  async combine(id: string, psbts: string[]) {
    const w = this.get(id);
    if (!Array.isArray(psbts) || psbts.length < 1) throw new HttpError(400, 'psbts must be a non-empty array');
    const combined = psbts.length === 1 ? psbts[0] : await this.rpc.call<string>('combinepsbt', [psbts]);
    return this.info(w, combined);
  }

  async finalize(id: string, psbt: string) {
    const w = this.get(id);
    const status = await this.info(w, psbt);
    const r = await this.rpc.call<{ complete: boolean; hex?: string }>('finalizepsbt', [psbt, true]);
    if (!r.complete || !r.hex) {
      throw new HttpError(422, `Not enough signatures to finalize: ${status.signatures}/${status.required}`, { signatures: status.signatures, required: status.required });
    }
    return { complete: true, hex: r.hex, txid: status.txid };
  }

  async broadcast(id: string, psbt: string) {
    const { hex } = await this.finalize(id, psbt);
    const txid = await this.rpc.call<string>('sendrawtransaction', [hex]);
    return { txid };
  }
}
