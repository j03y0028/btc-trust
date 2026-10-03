/** `npm run daily:snapshot`: append today's read-only mainnet snapshot to data/daily-blocks.json (idempotent per date). */
import { loadConfig } from '../config.js';
import { TimelineService } from '../timeline/service.js';

const cfg = loadConfig();
const t = new TimelineService(cfg);
try {
  const { created, snapshot: s } = await t.mainnet.snapshot();
  console.log(created ? `Recorded snapshot for ${s.date}` : `Snapshot for ${s.date} already recorded (no change)`);
  console.log(`  height     ${s.height}\n  hash       ${s.hash}\n  block time ${s.timeISO}\n  difficulty ${s.difficulty}\n  primary    ${s.primary}\n  check      ${s.check.status}${s.check.lagBlocks ? ` (lag ${s.check.lagBlocks})` : ''}`);
  for (const n of s.check.notes) console.log(`    - ${n}`);
  for (const src of s.sources) console.log(`  ${src.name.padEnd(17)} ${src.ok ? `ok   ${src.height} ${src.hash?.slice(0, 20)}…` : `FAIL ${src.error}`}`);
  const ref = await t.mainnet.fetchReference().catch((e) => { console.warn(`  reference data: ${(e as Error).message} (will retry)`); return null; });
  if (ref) console.log(`  genesis    ${ref.genesis.verified ? 'verified' : 'NOT verified'}: “${ref.genesis.headline}”`);
  console.log(`  log        ${t.mainnet.logFile}`);
} catch (e) {
  console.error(`Snapshot failed: ${(e as Error).message}`);
  process.exitCode = 1;
}
