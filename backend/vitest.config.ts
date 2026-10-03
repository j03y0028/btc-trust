import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    // Tests use a throwaway wallet store so they never touch the dev data/ directory.
    // Lower scrypt cost in tests for speed (production default N=2^17 is asserted separately).
    env: { DATA_DIR: mkdtempSync(join(tmpdir(), 'btctrust-test-')), VAULT_SCRYPT_N: '16384', RATE_LIMIT_GENERAL: '1000000', RATE_LIMIT_SENSITIVE: '1000000', RATE_LIMIT_OUTBOUND: '1000000' },
  },
});
