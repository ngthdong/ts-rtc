import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerApi, type ApiDeps } from './http/api.js';
import { attachSignaling, defaultSignalingOptions, type SignalingOptions } from './signaling.js';

export interface App {
  http: FastifyInstance;
  close(): Promise<void>;
}

export interface AppOptions extends Partial<SignalingOptions> {
  /** Dev only: GET /debug/media (live mediasoup object counts, Workers), /api/openapi.json. */
  debugRoutes?: boolean;
  /** The HTTP API (accounts, durable rooms). Absent: no /api routes. */
  api?: Omit<ApiDeps, 'closeLiveRoom'>;
}

export function buildApp(log: FastifyBaseLogger, options: AppOptions = {}): App {
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
  const media = options.media;
  if (options.debugRoutes && media) {
    http.get('/debug/media', async () => ({
      live: media.counts(),
      workers: await media.inspect(),
    }));
  }

  const signaling = attachSignaling(http.server, log, { ...defaultSignalingOptions, ...options });
  const api = options.api;
  if (api) {
    http.setValidatorCompiler(validatorCompiler);
    http.setSerializerCompiler(serializerCompiler);
    if (options.debugRoutes) {
      void http.register(swagger, {
        openapi: { info: { title: 'ts-rtc API', version: '1' } },
        transform: jsonSchemaTransform,
      });
      http.get('/api/openapi.json', { schema: { hide: true } }, () => http.swagger());
    }
    // A plugin of its own: its error handler covers the API only, and swagger sees its routes.
    void http.register((instance, _options, done) => {
      registerApi(instance, { ...api, closeLiveRoom: (roomId) => signaling.closeRoom(roomId) });
      done();
    });
  }

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
