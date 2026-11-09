import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 2577;
/** Match logs of the smoke runs (absolute: the server runs from server/). */
const LOG_DIR = resolve(import.meta.dirname, 'test-results/logs');

/** Browser smoke test against the production build served by the game server. */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // CROSSFIRE_DEBUG=1 so tests/e2e/heroes.spec.ts can try the debug hero switch (never in Docker).
    command: `npm run build -w client && PORT=${PORT} BIND_HOST=127.0.0.1 LOG_DIR=${LOG_DIR} CROSSFIRE_DEBUG=1 npm run server`,
    url: `http://localhost:${PORT}/api/lan`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
