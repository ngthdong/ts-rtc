import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { CloseCode, PROTOCOL_VERSION, SignalingError, type IceServer } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer } from 'ws';
import { RequestRouter } from './router.js';
import { Session, type SessionOptions } from './session.js';
import { leaveOnDisconnect, registerRoomHandlers, RoomRegistry } from './rooms/handlers.js';
import { registerReportHandlers } from './reports.js';
import type { RoomOptions } from './rooms/room.js';

export const WS_PATH = '/ws';
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface SignalingOptions extends SessionOptions, RoomOptions {
  // Browser origins allowed to open a WebSocket. Requests without Origin are not browsers.
  allowedOrigins: readonly string[];
  requestTimeoutMs: number;
  /** ICE servers (with fresh TURN credentials) handed to each client in session.welcome. */
  iceServersFor: (userKey: string) => IceServer[];
}

export const defaultSignalingOptions: SignalingOptions = {
  allowedOrigins: ['http://localhost:5173'],
  helloTimeoutMs: 5_000,
  pingIntervalMs: 10_000,
  requestTimeoutMs: 10_000,
  maxBufferedBytes: 1024 * 1024,
  capacity: 4,
  createdTtlMs: 10 * 60_000,
  emptyGraceMs: 60_000,
  iceServersFor: () => [],
};

export interface Signaling {
  close(): Promise<void>;
}

export function attachSignaling(
  server: Server,
  log: FastifyBaseLogger,
  options: SignalingOptions,
): Signaling {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const router = new RequestRouter(options.requestTimeoutMs)
    .on('session.hello', (payload, { session }) => {
      if (session.greeted) throw new SignalingError('INVALID_STATE', 'already greeted');
      if (!payload.protocolVersions.includes(PROTOCOL_VERSION)) {
        throw new SignalingError(
          'UNSUPPORTED_VERSION',
          `server speaks protocol v${PROTOCOL_VERSION}`,
          CloseCode.UnsupportedVersion,
        );
      }
      session.greeted = true;
      return {
        sessionId: session.id,
        protocolVersion: PROTOCOL_VERSION,
        heartbeatIntervalMs: options.pingIntervalMs,
        iceServers: options.iceServersFor(session.id),
      };
    })
    .on('session.heartbeat', () => ({ serverTime: Date.now() }));
  registerRoomHandlers(router, new RoomRegistry(options, log));
  registerReportHandlers(router);
  let closing = false;

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (pathname !== WS_PATH) return reject(socket, '404 Not Found');
    if (closing) return reject(socket, '503 Service Unavailable');
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      log.warn({ origin }, 'ws.origin_rejected');
      return reject(socket, '403 Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new Session(ws, log, router, options);
      session.onClose(() => {
        leaveOnDisconnect(session);
      });
    });
  });

  return {
    async close() {
      closing = true;
      await Promise.all(
        [...wss.clients].map(
          (ws) =>
            new Promise<void>((resolve) => {
              ws.once('close', () => {
                resolve();
              });
              ws.close(CloseCode.GoingAway, 'server shutting down');
              setTimeout(() => {
                ws.terminate();
              }, 1000).unref();
            }),
        ),
      );
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
  };
}

function reject(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}
