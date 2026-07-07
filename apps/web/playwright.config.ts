import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.TASKARA_E2E_PORT || 3190);
const host = '127.0.0.1';
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run dev -- --host ${host} --port ${port}`,
    cwd: '.',
    env: {
      ...process.env,
      VITE_TASKARA_API_URL: 'http://127.0.0.1:4199',
    },
    reuseExistingServer: !process.env.CI,
    url: baseURL,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 950 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], viewport: { width: 393, height: 852 } },
    },
  ],
});
