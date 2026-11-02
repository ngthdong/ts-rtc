import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

// Must match the server's PORT (see apps/server/src/config.ts).
const apiPort = process.env.PORT ?? '4000';

// A tab closed mid-call resets its proxied WebSocket. Expected, so not worth a stack trace.
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (msg, options) => {
  if (/ws proxy (socket )?error/.test(msg) && /ECONNRESET|EPIPE/.test(msg)) return;
  logError(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      '/healthz': `http://127.0.0.1:${apiPort}`,
    },
  },
});
