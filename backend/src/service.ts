import type { BitcoinRpc } from './rpc.js';

export interface ChainSummary {
  network: string;
  height: number;
  headers: number;
  bestBlockHash: string;
  difficulty: number;
  verificationProgress: number;
  syncProgressPct: number;
  initialBlockDownload: boolean;
  sizeOnDisk: number;
  pruned: boolean;
  mempool: { size: number; bytes: number; usage: number; totalFeeBtc: number };
  node: { version: number; subversion: string; connections: number };
  timestamp: string;
}

export interface BlockSummary {
  height: number;
  hash: string;
  time: number;
  txCount: number;
  size: number;
  weight: number;
  difficulty: number;
  miner?: string;
}

interface BlockchainInfo {
  chain: string; blocks: number; headers: number; bestblockhash: string; difficulty: number;
  verificationprogress: number; initialblockdownload: boolean; size_on_disk: number; pruned: boolean;
}
interface MempoolInfo { size: number; bytes: number; usage: number; total_fee?: number }
interface NetworkInfo { version: number; subversion: string; connections: number }
interface Block { height: number; hash: string; time: number; nTx: number; size: number; weight: number; difficulty: number }

export function syncPercent(info: Pick<BlockchainInfo, 'verificationprogress' | 'blocks' | 'headers'>): number {
  // On regtest verificationprogress can be < 1 even when fully synced; treat blocks==headers as 100%.
  if (info.headers > 0 && info.blocks >= info.headers) return 100;
  return Math.min(100, Math.max(0, Math.round(info.verificationprogress * 10000) / 100));
}

export class ChainService {
  constructor(private rpc: BitcoinRpc) {}

  async summary(): Promise<ChainSummary> {
    const [bc, mp, net] = await Promise.all([
      this.rpc.call<BlockchainInfo>('getblockchaininfo'),
      this.rpc.call<MempoolInfo>('getmempoolinfo'),
      this.rpc.call<NetworkInfo>('getnetworkinfo'),
    ]);
    return {
      network: bc.chain,
      height: bc.blocks,
      headers: bc.headers,
      bestBlockHash: bc.bestblockhash,
      difficulty: bc.difficulty,
      verificationProgress: bc.verificationprogress,
      syncProgressPct: syncPercent(bc),
      initialBlockDownload: bc.initialblockdownload,
      sizeOnDisk: bc.size_on_disk,
      pruned: bc.pruned,
      mempool: { size: mp.size, bytes: mp.bytes, usage: mp.usage, totalFeeBtc: mp.total_fee ?? 0 },
      node: { version: net.version, subversion: net.subversion, connections: net.connections },
      timestamp: new Date().toISOString(),
    };
  }

  async recentBlocks(count = 10): Promise<BlockSummary[]> {
    const n = Math.min(Math.max(1, Math.floor(count)), 50);
    const tip = await this.rpc.call<number>('getblockcount');
    const heights = Array.from({ length: Math.min(n, tip + 1) }, (_, i) => tip - i);
    return Promise.all(
      heights.map(async (h) => {
        const hash = await this.rpc.call<string>('getblockhash', [h]);
        const b = await this.rpc.call<Block>('getblock', [hash, 1]);
        return { height: b.height, hash: b.hash, time: b.time, txCount: b.nTx, size: b.size, weight: b.weight, difficulty: b.difficulty };
      }),
    );
  }
}
