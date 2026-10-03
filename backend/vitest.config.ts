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
    env: { DATA_DIR: mkdtempSync(join(tmpdir(), 'btctrust-test-')) },
  },
});
