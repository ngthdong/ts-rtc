import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Must match the server's PORT (see apps/server/src/config.ts).
const apiPort = process.env.PORT ?? '4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      '/healthz': `http://127.0.0.1:${apiPort}`,
    },
  },
});
