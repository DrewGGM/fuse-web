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
  // reuseExistingServer is off even locally: it twice served the Android
  // repository's preview instead of this one, because both projects run a Vite
  // preview and a killed run leaves the port held. A suite that tests whatever
  // happens to be listening is not testing anything.
  webServer: {
    // `vite preview` serves the built output, which is what the service worker
    // and the CSP need — a dev server serves neither the way production does.
    //
    // Port 4180, not the usual 4173: the Android repository's preview uses that,
    // and with reuseExistingServer a stale one silently serves the wrong build.
    // Half an hour went into a manifest that was missing because of it.
    // FUSE_API_BASE points at a port nothing listens on, so the suite cannot
    // reach the real API even by accident. The leaderboard tests stub the
    // network themselves; the rest must never touch production, which they did
    // the moment the API went live — submitting fabricated runs to a real board.
    command: 'cross-env FUSE_API_BASE=http://127.0.0.1:9 npm run build && npm run preview',
    url: 'http://localhost:4180',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
