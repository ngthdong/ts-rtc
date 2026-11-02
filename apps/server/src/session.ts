import { randomUUID } from 'node:crypto';
import { ClientRequest, CloseCode, type ServerMessage } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import type { Outcome, RequestRouter } from './router.js';

export interface SessionOptions {
  helloTimeoutMs: number;
  pingIntervalMs: number;
  maxBufferedBytes: number;
}

// Responses are cached per request id so a retried request is answered, not re-run.
const RESPONSE_CACHE_SIZE = 256;

export class Session {
  readonly id = randomUUID();
  readonly log: FastifyBaseLogger;
  greeted = false;
  private readonly responses = new Map<string, Promise<Outcome>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private awaitingPong = false;

  constructor(
    private readonly ws: WebSocket,
    log: FastifyBaseLogger,
    private readonly router: RequestRouter,
    private readonly options: SessionOptions,
  ) {
    this.log = log.child({ sessionId: this.id });
    this.timers.push(
      setTimeout(() => {
        if (!this.greeted) this.close(CloseCode.HandshakeTimeout, 'session.hello not received');
      }, options.helloTimeoutMs),
      setInterval(() => {
        this.checkAlive();
      }, options.pingIntervalMs),
    );
    ws.on('pong', () => {
      this.awaitingPong = false;
    });
    ws.on('message', (data, isBinary) => {
      this.onMessage(data, isBinary);
    });
    ws.on('close', (code) => {
      for (const timer of this.timers) clearTimeout(timer);
      this.log.info({ code }, 'ws.close');
    });
    ws.on('error', (err) => {
      this.log.warn({ err }, 'ws.error');
    });
    this.log.info('ws.open');
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > this.options.maxBufferedBytes) {
      this.log.warn({ bufferedAmount: this.ws.bufferedAmount }, 'ws.slow_consumer');
      this.close(CloseCode.TryAgainLater, 'slow consumer');
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason.slice(0, 120));
  }

  private checkAlive(): void {
    if (this.awaitingPong) {
      this.log.warn('ws.heartbeat_timeout');
      this.ws.terminate();
      return;
    }
    this.awaitingPong = true;
    this.ws.ping();
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.close(CloseCode.UnsupportedData, 'binary frames are not supported');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(toText(data));
    } catch {
      this.close(CloseCode.InvalidPayload, 'invalid JSON');
      return;
    }
    const request = ClientRequest.safeParse(json);
    if (!request.success) {
      // Without a valid id there is nothing to correlate an error response with.
      this.close(CloseCode.InvalidPayload, 'invalid envelope');
      return;
    }
    void this.handle(request.data);
  }

  private async handle(req: ClientRequest): Promise<void> {
    let outcome = this.responses.get(req.id);
    if (outcome) {
      this.log.debug({ requestId: req.id }, 'request.duplicate');
    } else {
      outcome = this.router.dispatch(req, { session: this, log: this.log });
      this.responses.set(req.id, outcome);
      if (this.responses.size > RESPONSE_CACHE_SIZE) {
        const oldest = this.responses.keys().next();
        if (!oldest.done) this.responses.delete(oldest.value);
      }
    }
    const { response, closeCode } = await outcome;
    this.send(response);
    if (closeCode !== undefined) {
      this.close(closeCode, response.ok ? '' : response.error.message);
    }
  }
}

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
