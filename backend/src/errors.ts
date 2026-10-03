import { RpcError } from './rpc.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

/** bitcoind error codes that indicate a bad request rather than a node problem. */
const CLIENT_RPC_CODES = new Set([-3, -4, -5, -6, -8, -22, -25, -26, -27]);

export function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const st = (err as { status?: unknown } | null)?.status;
  if (typeof st === 'number' && st >= 400 && st < 600) return st; // ReadOnlyViolation, ChainRefused (403)
  if (err instanceof RpcError) return err.code !== undefined && CLIENT_RPC_CODES.has(err.code) ? 400 : 502;
  return 500;
}
