import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/regression/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    // Match logs written by tests go to a temp folder, never to logs/.
    env: { LOG_DIR: join(tmpdir(), 'crossfire-test-logs') },
  },
});
