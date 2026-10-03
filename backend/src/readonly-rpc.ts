import { readFileSync } from 'node:fs';
import { BitcoinRpc, RpcError } from './rpc.js';

/** Anything with Bitcoin Core's JSON-RPC `call` shape. */
export interface RpcLike {
  call<T = unknown>(method: string, params?: unknown[] | Record<string, unknown>, wallet?: string): Promise<T>;
}

/**
 * The ONLY RPC methods this app may send to a mainnet node (e.g. Joey's myNode). All are pure chain/network reads:
 * no wallet, signing, sending, importing, mining, peer, ban, mempool-write or node-control methods. The same list is
 * emitted as a bitcoind `rpcwhitelist=` line (docs/mynode-install.md) so bitcoind enforces it a second time.
 */
export const READ_ONLY_METHODS = Object.freeze([
  'getblockchaininfo', 'getblockcount', 'getbestblockhash', 'getblockhash', 'getblockheader', 'getblock',
  'getblockstats', 'getchaintips', 'getchaintxstats', 'getdifficulty', 'getmempoolinfo', 'getnetworkinfo',
  'getconnectioncount', 'estimatesmartfee', 'uptime',
] as const);
export type ReadOnlyMethod = (typeof READ_ONLY_METHODS)[number];
const ALLOWED: ReadonlySet<string> = new Set(READ_ONLY_METHODS);

export class ReadOnlyViolation extends RpcError {
  readonly status = 403;
  constructor(method: string, why: string) {
    super(`Refused RPC "${method}" to the read-only mainnet node: ${why}`, -32604);
    this.name = 'ReadOnlyViolation';
  }
}

/** The wallet node turned out to be on a chain wallets may not use (mainnet in split mode). */
export class ChainRefused extends RpcError {
  readonly status = 403;
  constructor(msg: string) { super(msg, -32605); this.name = 'ChainRefused'; }
}

export const isReadOnlyMethod = (m: string): m is ReadOnlyMethod => ALLOWED.has(m);

export interface ReadOnlyNode {
  host: string; port: number; user: string; password: string;
  /** Bitcoin Core cookie file (`__cookie__:<hex>`), read on every call because bitcoind rotates it on restart. */
  cookieFile?: string;
  /** Chain the node must report (`main` in production; a stand-in regtest/signet node in the myNode simulation). */
  expectChain?: string;
}

/**
 * JSON-RPC client that can only read. Enforced in code before any bytes leave the process:
 *  - method must be in READ_ONLY_METHODS (exact, case-sensitive match — bitcoind method names are lowercase)
 *  - never a wallet endpoint (/wallet/<name>)
 *  - no batch requests (the client has no batch API)
 * Every refusal is counted and kept so the UI / tests can show it.
 */
export class ReadOnlyRpc implements RpcLike {
  readonly refused: { method: string; at: string }[] = [];
  private chainChecked: string | null = null;
  constructor(readonly node: ReadOnlyNode, private timeoutMs = 10_000, private make = (c: ConstructorParameters<typeof BitcoinRpc>[0]) => new BitcoinRpc(c)) {}

  get allowlist(): readonly string[] { return READ_ONLY_METHODS; }

  private client() {
    let { user, password } = this.node;
    if (this.node.cookieFile) {
      const raw = readFileSync(this.node.cookieFile, 'utf8').trim();
      const i = raw.indexOf(':');
      if (i < 0) throw new RpcError(`Malformed cookie file ${this.node.cookieFile}`);
      user = raw.slice(0, i); password = raw.slice(i + 1);
    }
    return this.make({ rpcHost: this.node.host, rpcPort: this.node.port, rpcUser: user, rpcPassword: password, rpcTimeoutMs: this.timeoutMs });
  }

  async call<T = unknown>(method: string, params: unknown[] | Record<string, unknown> = [], wallet?: string): Promise<T> {
    const refuse = (why: string): never => {
      this.refused.push({ method: String(method), at: new Date().toISOString() });
      if (this.refused.length > 100) this.refused.shift();
      throw new ReadOnlyViolation(String(method), why);
    };
    if (typeof method !== 'string' || !ALLOWED.has(method)) refuse('not in the read-only allowlist');
    if (wallet !== undefined) refuse('wallet endpoints are never used on mainnet');
    if (params !== undefined && typeof params !== 'object') refuse('invalid params');
    return this.client().call<T>(method, params);
  }

  /** getblockchaininfo, and refuse to continue if the node is on an unexpected chain. */
  async chain(): Promise<string> {
    const info = await this.call<{ chain: string }>('getblockchaininfo');
    const want = this.node.expectChain ?? 'main';
    if (info.chain !== want) throw new RpcError(`Read-only node is on "${info.chain}", expected "${want}"`);
    this.chainChecked = info.chain;
    return info.chain;
  }
  get verifiedChain() { return this.chainChecked; }
}

/**
 * Wallet-side RPC client for split mode: before the first call it asks the node which chain it is on and refuses
 * every call if that is mainnet. This catches a misconfiguration where BITCOIN_RPC_* points at the real node.
 */
export class TestChainRpc extends BitcoinRpc {
  private verified: Promise<string> | null = null;
  constructor(cfg: ConstructorParameters<typeof BitcoinRpc>[0], private allowed: readonly string[] = ['regtest', 'signet', 'test', 'testnet4']) { super(cfg); }
  async call<T = unknown>(method: string, params: unknown[] | Record<string, unknown> = [], wallet?: string): Promise<T> {
    this.verified ??= super.call<{ chain: string }>('getblockchaininfo').then((i) => i.chain).catch((e) => { this.verified = null; throw e; });
    const chain = await this.verified;
    if (!this.allowed.includes(chain)) throw new ChainRefused(`Wallet features refused: the wallet node is on "${chain}". In myNode split mode wallets run only on ${this.allowed.join('/')}.`);
    return super.call<T>(method, params, wallet);
  }
}

/** bitcoin.conf lines that make bitcoind enforce the same allowlist for a dedicated RPC user. */
export function rpcWhitelistConf(user: string, methods: readonly string[] = READ_ONLY_METHODS) {
  if (!/^[A-Za-z0-9_-]+$/.test(user)) throw new Error('RPC user must be alphanumeric');
  return `rpcwhitelist=${user}:${methods.join(',')}\n# Keep every other RPC user (myNode's own "mynode" user, other apps) unrestricted:\nrpcwhitelistdefault=0\n`;
}

/** Same algorithm as Bitcoin Core's share/rpcauth/rpcauth.py: HMAC-SHA256(key = hex salt string, msg = password). */
export async function rpcauthLine(user: string, password: string, salt?: string) {
  const { createHmac, randomBytes } = await import('node:crypto');
  if (!/^[A-Za-z0-9_-]+$/.test(user)) throw new Error('RPC user must be alphanumeric');
  const s = salt ?? randomBytes(16).toString('hex');
  return `rpcauth=${user}:${s}$${createHmac('sha256', s).update(password).digest('hex')}`;
}
