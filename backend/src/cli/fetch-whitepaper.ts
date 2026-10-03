/** Download https://bitcoin.org/bitcoin.pdf and bundle it only if its SHA-256 matches the published hash. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WHITEPAPER, sha256Hex } from '../timeline/chain.js';
import { USER_AGENT } from '../timeline/fetcher.js';
import { WHITEPAPER_FILE } from '../timeline/service.js';

const res = await fetch(WHITEPAPER.url, { headers: { 'user-agent': USER_AGENT } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const hash = sha256Hex(buf);
if (hash !== WHITEPAPER.sha256) {
  console.error(`SHA-256 mismatch: got ${hash}, expected ${WHITEPAPER.sha256}. Not bundling.`);
  process.exit(1);
}
mkdirSync(dirname(WHITEPAPER_FILE), { recursive: true });
writeFileSync(WHITEPAPER_FILE, buf);
console.log(`Verified ${buf.length} bytes, sha256 ${hash} → ${WHITEPAPER_FILE}`);
