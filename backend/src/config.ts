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
    allowMainnet,
    dataDir: env.DATA_DIR ?? resolve(import.meta.dirname, '../../data'),
    hwi: {
      mode: (env.HWI_MODE ?? 'auto') as AppConfig['hwi']['mode'],
      bin: env.HWI_PATH ?? '/workspace/hwi/hwi',
      // Emulators (Trezor emulator, Speculos, Coldcard sim) are only enumerated off-mainnet unless forced.
      emulators: (env.HWI_EMULATORS ?? (network === 'main' ? 'false' : 'true')) === 'true',
      timeoutMs: Number(env.HWI_TIMEOUT_MS ?? 120000),
    },
  };
}
