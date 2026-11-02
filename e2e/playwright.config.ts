import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Same .env as the server, so the relay test knows whether coturn is configured.
if (existsSync('../.env')) process.loadEnvFile('../.env');

// Must match the server's PORT (see apps/server/src/config.ts).
const apiPort = process.env.PORT ?? '4000';

// Real browsers, real server, fake camera and microphone. Chromium only (scope v2).
export default defineConfig({
  testMatch: '*.e2e.ts',
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:5173',
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  webServer: [
    {
      // No watch mode: a file saved mid-run would restart the server and drop every call.
      command: 'pnpm --filter @ts-rtc/server start',
      url: `http://127.0.0.1:${apiPort}/healthz`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm --filter @ts-rtc/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
