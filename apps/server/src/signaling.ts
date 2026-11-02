import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { DebugEchoRequest, type DebugEchoReply } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export const WS_PATH = '/ws';
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** WebSocket close codes used by the server (RFC 6455 section 7.4.1). */
export const CloseCode = {
  GoingAway: 1001,
  UnsupportedData: 1003,
  InvalidPayload: 1007,
  // 1009 (message too big) is sent by `ws` itself when maxPayload is exceeded.
} as const;

export interface Signaling {
  close(): Promise<void>;
}

/** Accepts WebSocket upgrades on WS_PATH only and answers debug.echo (Stage 1). */
export function attachSignaling(server: Server, log: FastifyBaseLogger): Signaling {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  let closing = false;

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH || closing) {
      socket.end(`HTTP/1.1 ${closing ? '503 Service Unavailable' : '404 Not Found'}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws);
    });
  });

  function onConnection(ws: WebSocket): void {
    const sessionId = randomUUID();
    const sessionLog = log.child({ sessionId });
    sessionLog.info('ws.open');

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(CloseCode.UnsupportedData, 'binary frames are not supported');
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(toText(data));
      } catch {
        ws.close(CloseCode.InvalidPayload, 'invalid JSON');
        return;
      }
      const request = DebugEchoRequest.safeParse(json);
      if (!request.success) {
        ws.close(CloseCode.InvalidPayload, 'invalid message');
        return;
      }
      const reply: DebugEchoReply = {
        type: 'debug.echo',
        payload: request.data.payload,
        sessionId,
      };
      ws.send(JSON.stringify(reply));
    });
    ws.on('close', (code) => {
      sessionLog.info({ code }, 'ws.close');
    });
    ws.on('error', (err) => {
      sessionLog.warn({ err }, 'ws.error');
    });
  }

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

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
