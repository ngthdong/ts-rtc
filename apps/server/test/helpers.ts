import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ServerMessage, type SignalingEvent } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import { WebSocket } from 'ws';
import { buildApp, type App } from '../src/app.js';
import type { SignalingOptions } from '../src/signaling.js';

export async function startServer(
  options: Partial<SignalingOptions> = {},
  log: FastifyBaseLogger = pino({ level: 'silent' }),
) {
  const app: App = buildApp(log, options);
  await app.http.listen({ host: '127.0.0.1', port: 0 });
  const host = `127.0.0.1:${(app.http.server.address() as AddressInfo).port}`;
  return { app, host };
}

type Response = Extract<ServerMessage, { kind: 'res' }>;

export class TestClient {
  readonly events: SignalingEvent[] = [];
  readonly closed: Promise<number>;
  private readonly responses = new Map<string, Response>();
  private nextId = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      if (message.kind === 'res') this.responses.set(message.id, message);
      else this.events.push({ type: message.type, payload: message.payload } as SignalingEvent);
    });
    this.closed = new Promise((resolve) => ws.once('close', resolve));
  }

  static async connect(
    host: string,
    options: { path?: string; origin?: string; autoPong?: boolean } = {},
  ) {
    const { path = '/ws', origin, autoPong = true } = options;
    const ws = new WebSocket(`ws://${host}${path}`, { autoPong, ...(origin ? { origin } : {}) });
    await once(ws, 'open');
    return new TestClient(ws);
  }

  static async greeted(host: string): Promise<TestClient> {
    const client = await TestClient.connect(host);
    await client.request('session.hello', { protocolVersions: [1] });
    return client;
  }

  send(frame: string | Buffer): void {
    this.ws.send(frame);
  }

  async request(type: string, payload: unknown, id = `r${++this.nextId}`): Promise<Response> {
    this.ws.send(JSON.stringify({ v: 1, kind: 'req', id, type, payload }));
    await until(() => this.responses.has(id));
    const response = this.responses.get(id);
    this.responses.delete(id);
    if (!response) throw new Error('unreachable');
    return response;
  }

  async ok<T = Record<string, unknown>>(type: string, payload: unknown): Promise<T> {
    const response = await this.request(type, payload);
    if (!response.ok) throw new Error(`${type} failed: ${response.error.code}`);
    return response.payload as T;
  }

  async waitForEvent(type: SignalingEvent['type']): Promise<SignalingEvent> {
    await until(() => this.events.some((e) => e.type === type));
    const index = this.events.findIndex((e) => e.type === type);
    return this.events.splice(index, 1)[0] as SignalingEvent;
  }

  close(): void {
    this.ws.close();
  }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
