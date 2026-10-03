import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TEST_RE = /^\s*(it|test)(\.each\(.*\))?\(/gm;

export interface StageProgress { id: number; title: string; achievements: string[]; commit: { hash: string; short: string; date: string; subject: string } | null; tests: { backend: number; frontend: number; source: string } | null }

const STAGES: { id: number; title: string; achievements: string[] }[] = [
  { id: 0, title: 'Foundation', achievements: ['Bitcoin Core regtest node scripts (start/stop/mine)', 'Express + TypeScript backend, React + Vite frontend', 'Typecheck, tests and build wired into npm test'] },
  { id: 1, title: 'Node Dashboard', achievements: ['Chain info, blocks and mempool API over JSON-RPC', 'Live dashboard with stage tracker', 'Regtest-only safety guard'] },
  { id: 2, title: 'Multisig Wallet', achievements: ['2-of-3 P2WSH default, single-sig, m-of-n, watch-only', 'Descriptor wallets with checksums', 'PSBT create → sign → combine → finalize → broadcast'] },
  { id: 3, title: 'Hardware Wallets', achievements: ['HWI integration tested against the Trezor emulator', 'Mock adapter + software fallback', 'Air-gapped PSBT via file and QR', 'Devices UI'] },
  { id: 4, title: 'Trust Vault', achievements: ['scrypt + AES-256-GCM encrypted trust documents', 'Wallet-signature second factor', 'SHA-256 versions anchored via regtest OP_RETURN', 'Encrypted backup / restore'] },
  { id: 5, title: 'Trustee Messaging', achievements: ['End-to-end encryption (X25519 / XSalsa20-Poly1305 / Ed25519)', 'signmessage attestations and PSBT signature requests', 'WebSocket delivery, offline queue, urgent escalation'] },
  { id: 6, title: 'Timeline & Goals', achievements: ['FRED macro series (CPI, M2, fed funds, GDP, unemployment) cached with source + fetch date', 'Cited U.S. economy events alongside Bitcoin milestones', 'White paper bundled after SHA-256 verification; genesis headline decoded from mainnet data', 'Read-only daily mainnet snapshots cross-checked across mempool.space and blockstream.info'] },
  { id: 7, title: 'Hardening', achievements: ['Trustee keys encrypted in the browser (scrypt + AES-256-GCM) with idle auto-lock and v1 migration', 'Browser re-verifies every BIP-137 key attestation instead of trusting the server', 'Coldcard multisig setup file + Ledger BIP-388 policy (mock device); Trezor needs no registration', 'Animated BC-UR crypto-psbt QR export and camera/paste import', 'Security review: Host/Origin guards, rate limits, helmet + CSP, owner-only data files, npm audit clean'] },
];

export const BACKLOG = [
  { title: 'Tor transport', detail: 'Route trustee messaging and node RPC over Tor onion services.' },
  { title: 'myNode packaging', detail: 'Ship as a myNode app that reads from the local node (getblockchaininfo) instead of public APIs.' },
  { title: 'Independent security audit', detail: 'External review of the crypto, key handling and PSBT flows before any mainnet use (see docs/security-review.md).' },
  { title: 'Real-device Ledger & Coldcard validation', detail: 'Register the BIP-388 policy on a physical Ledger (ledger_bitcoin) and import the setup file on a Coldcard; Stage 7 verified them against a mock and bitcoind only.' },
  { title: 'API authentication', detail: 'Per-trustee login for the API before it is exposed beyond localhost (today it relies on loopback binding + Host/Origin checks).' },
];

function countTree(root: string, dir: string, exts = /\.test\.tsx?$/): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.test(e)) n += (readFileSync(p, 'utf8').match(TEST_RE) ?? []).length;
    }
  };
  walk(join(root, dir));
  return n;
}

async function countAt(root: string, rev: string, path: string) {
  try {
    const { stdout } = await run('git', ['grep', '-h', '-E', '^\\s*(it|test)(\\.each\\(.*\\))?\\(', rev, '--', path], { cwd: root });
    return stdout.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

/** Stage progress read from git: commit per stage (subject "Stage N" / "Stage N+M"), test cases at that commit. */
export async function stageProgress(root: string, statuses: Record<number, string>): Promise<{ stages: (StageProgress & { status: string })[]; head: string | null; dirty: boolean }> {
  let log: { hash: string; date: string; subject: string }[] = [];
  let head: string | null = null;
  let dirty = false;
  try {
    const { stdout } = await run('git', ['log', '--format=%H%x09%aI%x09%s'], { cwd: root });
    log = stdout.trim().split('\n').filter(Boolean).map((l) => { const [hash, date, subject] = l.split('\t'); return { hash, date, subject }; });
    head = log[0]?.hash ?? null;
    dirty = (await run('git', ['status', '--porcelain'], { cwd: root })).stdout.trim().length > 0;
  } catch { /* not a git checkout */ }
  const stages = [];
  for (const s of STAGES) {
    const c = log.find((l) => { const m = /^Stage (\d)(?:\+(\d))?\b/.exec(l.subject); return !!m && (Number(m[1]) === s.id || Number(m[2]) === s.id); });
    const commit = c ? { hash: c.hash, short: c.hash.slice(0, 7), date: c.date, subject: c.subject } : null;
    const tests = commit
      ? { backend: await countAt(root, commit.hash, 'backend/test'), frontend: await countAt(root, commit.hash, 'frontend/src'), source: `git ${commit.short}` }
      : statuses[s.id] !== 'planned' ? { backend: countTree(root, 'backend/test'), frontend: countTree(root, 'frontend/src'), source: 'working tree' } : null;
    stages.push({ ...s, status: statuses[s.id] ?? 'planned', commit, tests });
  }
  return { stages, head, dirty };
}
export const repoRelative = (root: string, p: string) => relative(root, p);
