import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { mintTurnCredentials } from './turn/credentials.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();

const log = pino({
  level: config.LOG_LEVEL,
  base: { service: 'ts-rtc-server', env: config.NODE_ENV },
});

const turn = config.TURN_SECRET
  ? { secret: config.TURN_SECRET, urls: config.TURN_URLS, ttlSeconds: config.TURN_TTL_SECONDS }
  : undefined;
if (!turn) log.warn('TURN_SECRET not set: no TURN, calls work on one machine or LAN only');

const app = buildApp(log, {
  allowedOrigins: config.ALLOWED_ORIGINS,
  // The session id is the pseudonymous userKey in TURN usernames (Stage 14: the user id).
  iceServersFor: (userKey) => [
    ...config.ICE_SERVERS,
    ...(turn ? [mintTurnCredentials(turn, userKey)] : []),
  ],
});

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
