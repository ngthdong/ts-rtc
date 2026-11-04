import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { CloseCode, PROTOCOL_VERSION, SignalingError, type IceServer } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer } from 'ws';
import { closedDirectory, type Directory } from './auth/directory.js';
import { RequestRouter } from './router.js';
import { Session, type SessionOptions } from './session.js';
import { leaveOnDisconnect, registerRoomHandlers, RoomRegistry } from './rooms/handlers.js';
import { registerReportHandlers } from './reports.js';
import { registerSfuHandlers } from './rooms/sfu-handlers.js';
import type { RoomOptions } from './rooms/room.js';
import type { MediaController } from './media/media-controller.js';

export const WS_PATH = '/ws';
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface SignalingOptions extends SessionOptions, RoomOptions {
  // Browser origins allowed to open a WebSocket. Requests without Origin are not browsers.
  allowedOrigins: readonly string[];
  requestTimeoutMs: number;
  /** ICE servers (with fresh TURN credentials) handed to each client in session.welcome. */
  iceServersFor: (userKey: string) => IceServer[];
  /** Access tokens and durable rooms (Postgres). The default lets nobody in. */
  directory: Directory;
  /** RoomOptions.capacity is for Mesh rooms; SFU rooms hold more. */
  sfuCapacity: number;
  /** The SFU. Absent: Mesh rooms only. */
  media?: MediaController | undefined;
}

export const defaultSignalingOptions: SignalingOptions = {
  allowedOrigins: ['http://localhost:5173'],
  helloTimeoutMs: 5_000,
  pingIntervalMs: 10_000,
  requestTimeoutMs: 10_000,
  maxBufferedBytes: 1024 * 1024,
  capacity: 4,
  sfuCapacity: 10,
  createdTtlMs: 10 * 60_000,
  emptyGraceMs: 60_000,
  iceServersFor: () => [],
  directory: closedDirectory,
};

export interface Signaling {
  /** Ends a room's live call: its durable room was deleted (room.closed {reason: 'deleted'}). */
  closeRoom(roomId: string): Promise<void>;
  close(): Promise<void>;
}

export function attachSignaling(
  server: Server,
  log: FastifyBaseLogger,
  options: SignalingOptions,
): Signaling {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const router = new RequestRouter(options.requestTimeoutMs)
    .on('session.hello', async (payload, { session }) => {
      if (session.greeted) throw new SignalingError('INVALID_STATE', 'already greeted');
      if (!payload.protocolVersions.includes(PROTOCOL_VERSION)) {
        throw new SignalingError(
          'UNSUPPORTED_VERSION',
          `server speaks protocol v${PROTOCOL_VERSION}`,
          CloseCode.UnsupportedVersion,
        );
      }
      const user = payload.accessToken
        ? await options.directory.authenticate(payload.accessToken).catch((err: unknown) => {
            if (!(err instanceof SignalingError)) throw err;
            // Database down: retryable, so close with "try again later", not "sign in again".
            throw new SignalingError(err.code, err.message, CloseCode.TryAgainLater, {
              cause: err,
            });
          })
        : undefined;
      if (!user) {
        throw new SignalingError(
          'UNAUTHENTICATED',
          'missing, invalid or expired access token: sign in again',
          CloseCode.Unauthenticated,
        );
      }
      session.user = user;
      session.greeted = true;
      return {
        sessionId: session.id,
        protocolVersion: PROTOCOL_VERSION,
        heartbeatIntervalMs: options.pingIntervalMs,
        iceServers: options.iceServersFor(user.id), // TURN usernames carry the user id
      };
    })
    .on('session.heartbeat', () => ({ serverTime: Date.now() }));
  const rooms = new RoomRegistry(options, log, options.directory, options.media);
  registerRoomHandlers(router, rooms);
  registerSfuHandlers(router, rooms);
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
        leaveOnDisconnect(session, rooms);
      });
    });
  });

  return {
    closeRoom: (roomId) => rooms.close(roomId, 'deleted'),
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
