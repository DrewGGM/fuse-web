import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: 'http://localhost:4180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // A mid-range Android viewport, because that is the device the design targets.
      name: 'web',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    // `vite preview` serves the built output, which is what the service worker
    // and the CSP need — a dev server serves neither the way production does.
    //
    // Port 4180, not the usual 4173: the Android repository's preview uses that,
    // and with reuseExistingServer a stale one silently serves the wrong build.
    // Half an hour went into a manifest that was missing because of it.
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4180',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
