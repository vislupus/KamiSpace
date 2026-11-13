import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.MINDDOCK_E2E_PORT || 8791);

// Browser tests run against a throwaway server (see tests/e2e_server.py).
// Build the frontend first: `npm run build`.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1366, height: 768 },
    trace: 'off',
    // Use a system/preinstalled Chromium when PLAYWRIGHT_CHROMIUM_PATH is set.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } }],
  webServer: {
    command: `uv run python tests/e2e_server.py ${PORT}`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
