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
  mainnet: { node: { host: string; port: number; user: string; password: string; cookieFile?: string; expectChain: string } | null; snapshots: boolean };
  /**
   * standalone: one node for everything (regtest by default).
   * split (myNode): chain data is read from the mainnet node through the read-only client, while wallets, vault,
   * messaging and PSBTs use the separate test node (BITCOIN_RPC_*, regtest/signet) — or are switched off.
   */
  mode: 'standalone' | 'split';
  walletFeatures: boolean;
  /** App login. auto = required whenever the API binds beyond loopback. */
  auth: { mode: 'auto' | 'on' | 'off'; scryptN: number; sessionIdleMs: number; sessionMaxMs: number; setupToken?: string };
  /** Serve the built frontend from the API (single port, Docker/myNode). */
  staticDir: string | null;
  /** Repo/app root (bundled white paper, git metadata). */
  appRoot: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const network = (env.BITCOIN_NETWORK ?? 'regtest') as Network;
  if (!(network in DEFAULT_PORTS)) throw new Error(`Unsupported BITCOIN_NETWORK: ${network}`);
  const allowMainnet = env.ALLOW_MAINNET === 'true';
  const mode = (env.APP_MODE ?? (env.MAINNET_RPC_HOST && network !== 'main' ? 'split' : 'standalone')) as AppConfig['mode'];
  if (mode !== 'split' && mode !== 'standalone') throw new Error(`Unsupported APP_MODE: ${mode}`);
  if (mode === 'split' && network === 'main') {
    throw new Error('APP_MODE=split keeps wallets off mainnet: BITCOIN_NETWORK must be regtest, signet or testnet (the mainnet node goes in MAINNET_RPC_*).');
  }
  if (mode === 'split' && !env.MAINNET_RPC_HOST) throw new Error('APP_MODE=split needs MAINNET_RPC_HOST (your node, read-only).');
  const authMode = (env.AUTH_MODE ?? 'auto') as AppConfig['auth']['mode'];
  if (!['auto', 'on', 'off'].includes(authMode)) throw new Error(`Unsupported AUTH_MODE: ${authMode}`);
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
        ? { host: env.MAINNET_RPC_HOST, port: Number(env.MAINNET_RPC_PORT ?? 8332), user: env.MAINNET_RPC_USER ?? '', password: env.MAINNET_RPC_PASSWORD ?? '',
            ...(env.MAINNET_RPC_COOKIEFILE ? { cookieFile: env.MAINNET_RPC_COOKIEFILE } : {}),
            // Only the myNode simulation sets this (a regtest node stands in for mainnet). Production: main.
            expectChain: env.MAINNET_RPC_EXPECT_CHAIN ?? 'main' }
        : network === 'main' ? { host: env.BITCOIN_RPC_HOST ?? '127.0.0.1', port: Number(env.BITCOIN_RPC_PORT ?? 8332), user: env.BITCOIN_RPC_USER ?? '', password: env.BITCOIN_RPC_PASSWORD ?? '', expectChain: 'main' } : null,
      snapshots: (env.MAINNET_SNAPSHOTS ?? 'true') === 'true',
    },
    mode,
    walletFeatures: (env.WALLET_FEATURES ?? 'on') !== 'off',
    auth: {
      mode: authMode,
      scryptN: Number(env.AUTH_SCRYPT_N ?? 2 ** 17),
      sessionIdleMs: Number(env.AUTH_SESSION_IDLE_MS ?? 30 * 60_000),
      sessionMaxMs: Number(env.AUTH_SESSION_MAX_MS ?? 12 * 3600_000),
      ...(env.AUTH_SETUP_TOKEN ? { setupToken: env.AUTH_SETUP_TOKEN } : {}),
    },
    staticDir: env.STATIC_DIR ?? null,
    appRoot: env.APP_ROOT ?? resolve(import.meta.dirname, '../..'),
  };
}
