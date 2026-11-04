import { availableParallelism } from 'node:os';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { MediasoupController } from './media/mediasoup/mediasoup-controller.js';
import { mintTurnCredentials } from './turn/credentials.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();

const log = createLogger({
  level: config.LOG_LEVEL,
  env: config.NODE_ENV,
  version: config.APP_VERSION,
});

const turn = config.TURN_SECRET
  ? { secret: config.TURN_SECRET, urls: config.TURN_URLS, ttlSeconds: config.TURN_TTL_SECONDS }
  : undefined;
if (!turn) log.warn('TURN_SECRET not set: no TURN, calls work on one machine or LAN only');
if (config.MEDIA_LISTEN_IP === '0.0.0.0' && !config.MEDIA_ANNOUNCED_ADDRESS) {
  log.warn('MEDIA_ANNOUNCED_ADDRESS not set: SFU candidates will not be reachable');
}
const media = await MediasoupController.start(
  {
    count: config.WORKERS ?? Math.max(1, availableParallelism() - 1),
    listenIp: config.MEDIA_LISTEN_IP,
    announcedAddress: config.MEDIA_ANNOUNCED_ADDRESS,
    portBase: config.MEDIA_PORT_BASE,
    restartDelayMs: 2_000,
    maxRestartsPerMinute: 5,
    allowLoopback: config.ALLOW_LOOPBACK ?? config.NODE_ENV !== 'production',
    connectDeadlineMs: 30_000,
    iceDisconnectedMs: 30_000,
  },
  log,
);

const app = buildApp(log, {
  media,
  debugRoutes: config.NODE_ENV !== 'production',
  allowedOrigins: config.ALLOWED_ORIGINS,
  capacity: config.MESH_MAX_PARTICIPANTS,
  sfuCapacity: config.SFU_MAX_PARTICIPANTS,
  // The session id is the pseudonymous userKey in TURN usernames.
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
