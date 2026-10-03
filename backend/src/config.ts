import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Load ../.env (repo root) first, then backend/.env if present.
loadEnv({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });
loadEnv({ quiet: true });

export type Network = 'regtest' | 'testnet' | 'testnet4' | 'signet' | 'main';

const DEFAULT_PORTS: Record<Network, number> = {
  regtest: 18443,
  testnet: 18332,
  testnet4: 48332,
  signet: 38332,
  main: 8332,
};

export interface AppConfig {
  network: Network;
  rpcHost: string;
  rpcPort: number;
  rpcUser: string;
  rpcPassword: string;
  rpcTimeoutMs: number;
  apiPort: number;
  allowMainnet: boolean;
  dataDir: string;
  hwi: { mode: 'auto' | 'cli' | 'mock' | 'off'; bin: string; emulators: boolean; timeoutMs: number };
  vault: { idleMs: number; kdfN: number };
  /** Read-only mainnet observation for the timeline. No wallet RPCs are ever sent to this node. */
  /** API bind address (default loopback) and HTTP hardening. */
  apiHost: string;
  security: { allowedHosts: string[]; rateLimit: { general: number; sensitive: number; outbound: number } };
  mainnet: { node: { host: string; port: number; user: string; password: string } | null; snapshots: boolean };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const network = (env.BITCOIN_NETWORK ?? 'regtest') as Network;
  if (!(network in DEFAULT_PORTS)) throw new Error(`Unsupported BITCOIN_NETWORK: ${network}`);
  const allowMainnet = env.ALLOW_MAINNET === 'true';
  if (network === 'main' && !allowMainnet) {
    throw new Error('Mainnet is disabled for safety. Set ALLOW_MAINNET=true only if you really mean it.');
  }
  return {
    network,
    rpcHost: env.BITCOIN_RPC_HOST ?? '127.0.0.1',
    rpcPort: Number(env.BITCOIN_RPC_PORT ?? DEFAULT_PORTS[network]),
    rpcUser: env.BITCOIN_RPC_USER ?? '',
    rpcPassword: env.BITCOIN_RPC_PASSWORD ?? '',
    rpcTimeoutMs: Number(env.BITCOIN_RPC_TIMEOUT_MS ?? 10000),
    apiPort: Number(env.API_PORT ?? 4000),
    apiHost: env.API_HOST ?? '127.0.0.1',
    security: {
      allowedHosts: (env.API_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
      rateLimit: {
        general: Number(env.RATE_LIMIT_GENERAL ?? 1200),     // requests / minute / IP
        sensitive: Number(env.RATE_LIMIT_SENSITIVE ?? 30),   // passphrase, identity, signing
        outbound: Number(env.RATE_LIMIT_OUTBOUND ?? 6),      // triggers calls to public APIs
      },
    },
    allowMainnet,
    dataDir: env.DATA_DIR ?? resolve(import.meta.dirname, '../../data'),
    hwi: {
      mode: (env.HWI_MODE ?? 'auto') as AppConfig['hwi']['mode'],
      bin: env.HWI_PATH ?? '/workspace/hwi/hwi',
      // Emulators (Trezor emulator, Speculos, Coldcard sim) are only enumerated off-mainnet unless forced.
      emulators: (env.HWI_EMULATORS ?? (network === 'main' ? 'false' : 'true')) === 'true',
      timeoutMs: Number(env.HWI_TIMEOUT_MS ?? 120000),
    },
    vault: {
      idleMs: Number(env.VAULT_IDLE_MS ?? 5 * 60_000),
      kdfN: Number(env.VAULT_SCRYPT_N ?? 2 ** 17),
    },
    mainnet: {
      // e.g. a myNode box: MAINNET_RPC_HOST=mynode.local MAINNET_RPC_USER=... MAINNET_RPC_PASSWORD=...
      node: env.MAINNET_RPC_HOST
        ? { host: env.MAINNET_RPC_HOST, port: Number(env.MAINNET_RPC_PORT ?? 8332), user: env.MAINNET_RPC_USER ?? '', password: env.MAINNET_RPC_PASSWORD ?? '' }
        : network === 'main' ? { host: env.BITCOIN_RPC_HOST ?? '127.0.0.1', port: Number(env.BITCOIN_RPC_PORT ?? 8332), user: env.BITCOIN_RPC_USER ?? '', password: env.BITCOIN_RPC_PASSWORD ?? '' } : null,
      snapshots: (env.MAINNET_SNAPSHOTS ?? 'true') === 'true',
    },
  };
}
