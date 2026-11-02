import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { attachSignaling, defaultSignalingOptions, type SignalingOptions } from './signaling.js';

export interface App {
  http: FastifyInstance;
  close(): Promise<void>;
}

export function buildApp(log: FastifyBaseLogger, options: Partial<SignalingOptions> = {}): App {
  let ready = true;
  const http = Fastify({
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
  });

  http.get('/healthz', () => ({ status: 'ok' }));
  http.get('/readyz', (_req, reply) => {
    if (!ready) return reply.code(503).send({ status: 'shutting_down' });
    if (options.media?.healthy === false) return reply.code(503).send({ status: 'media_failing' });
    return { status: 'ready' };
  });

  const signaling = attachSignaling(http.server, log, { ...defaultSignalingOptions, ...options });

  let closed: Promise<void> | undefined;
  return {
    http,
    close() {
      closed ??= (async () => {
        ready = false;
        await signaling.close();
        await http.close();
        options.media?.close(); // Workers last: rooms are gone by now
      })();
      return closed;
    },
  };
}
