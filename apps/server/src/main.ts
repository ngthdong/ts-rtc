import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();

const log = pino({
  level: config.LOG_LEVEL,
  base: { service: 'ts-rtc-server', env: config.NODE_ENV },
});

const app = buildApp(log, { allowedOrigins: config.ALLOWED_ORIGINS });

await app.http.listen({ host: config.HOST, port: config.PORT });
log.info({ host: config.HOST, port: config.PORT }, 'server.listening');

function shutdown(signal: NodeJS.Signals): void {
  const startedAt = Date.now();
  log.info({ signal }, 'shutdown.begin');
  setTimeout(() => {
    log.error('shutdown.timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  app.close().then(
    () => {
      log.info({ durationMs: Date.now() - startedAt }, 'shutdown.complete');
      process.exit(0);
    },
    (err: unknown) => {
      log.error({ err }, 'shutdown.failed');
      process.exit(1);
    },
  );
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
