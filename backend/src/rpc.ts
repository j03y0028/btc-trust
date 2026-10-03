import type { AppConfig } from './config.js';

export class RpcError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Minimal Bitcoin Core JSON-RPC client (uses global fetch). */
export class BitcoinRpc {
  private id = 0;
  constructor(private cfg: Pick<AppConfig, 'rpcHost' | 'rpcPort' | 'rpcUser' | 'rpcPassword' | 'rpcTimeoutMs'>) {}

  async call<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const path = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/';
    const url = `http://${this.cfg.rpcHost}:${this.cfg.rpcPort}${path}`;
    const auth = Buffer.from(`${this.cfg.rpcUser}:${this.cfg.rpcPassword}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
        body: JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.cfg.rpcTimeoutMs),
      });
    } catch (e) {
      throw new RpcError(`Cannot reach bitcoind at ${this.cfg.rpcHost}:${this.cfg.rpcPort}: ${(e as Error).message}`);
    }
    if (res.status === 401) throw new RpcError('bitcoind RPC authentication failed (check BITCOIN_RPC_USER/PASSWORD)', 401);
    const text = await res.text();
    let body: { result: T; error: { code: number; message: string } | null };
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError(`Invalid RPC response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (body.error) throw new RpcError(body.error.message, body.error.code);
    return body.result;
  }
}
