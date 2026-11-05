import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Same .env as the server, so the relay test knows whether coturn is configured.
if (existsSync('../.env')) process.loadEnvFile('../.env');

// Must match the server's PORT (see apps/server/src/config.ts).
const apiPort = process.env.PORT ?? '4000';

const SERIAL = /(sfu-.*|recovery)\.e2e\.ts$/;
const OUTAGE = /Postgres down/;

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
  projects: [
    { name: 'mesh', testIgnore: SERIAL, grepInvert: OUTAGE },
    // These assert the server-wide mediasoup counts (/debug/media), and recovery kills Workers:
    // one test at a time. Mesh tests create no mediasoup objects, so they may run alongside.
    { name: 'sfu', testMatch: SERIAL, workers: 1, grepInvert: OUTAGE },
    // Stops Postgres for the whole server: alone, after everything else, or sign-ups elsewhere fail.
    { name: 'outage', grep: OUTAGE, dependencies: ['mesh', 'sfu'] },
  ],
  webServer: [
    {
      // No watch mode: a file saved mid-run would restart the server and drop every call.
      command: 'pnpm --filter @ts-rtc/server start',
      // Every simulated user signs up from 127.0.0.1: the per-IP auth limit would trip.
      env: { AUTH_RATE_PER_MINUTE: '10000' },
      // SERVER_LOGS=1: print the server's JSON log lines (prefixed [WebServer]).
      stdout: process.env.SERVER_LOGS ? 'pipe' : 'ignore',
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
