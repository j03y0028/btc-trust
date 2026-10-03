export type StageStatus = 'complete' | 'in-progress' | 'planned';
export interface Stage { id: number; title: string; description: string; status: StageStatus }

/** Product roadmap. Update status as stages land (Stage 1 flipped to complete once its tests pass). */
export const STAGES: Stage[] = [
  { id: 0, title: 'Foundation', description: 'Bitcoin Core (verified) on regtest, repo scaffold, config', status: 'complete' },
  { id: 1, title: 'Node Dashboard', description: 'Live chain stats, mempool, recent blocks via JSON-RPC', status: 'complete' },
  { id: 2, title: 'Multisig Wallet', description: '2-of-3 P2WSH descriptor wallet; single-sig / m-of-n / watch-only options', status: 'complete' },
  { id: 3, title: 'Hardware Wallets', description: 'PSBT export/import, HWI integration, software signer fallback', status: 'planned' },
  { id: 4, title: 'Trust Vault', description: 'Password-protected, encrypted-at-rest trust documentation', status: 'planned' },
  { id: 5, title: 'Trustee Messaging', description: 'Private internal channel between trustees', status: 'planned' },
  { id: 6, title: 'Timeline & Goals', description: 'US economy milestones vs. the Bitcoin white paper, daily block data, progress tracker', status: 'planned' },
];
