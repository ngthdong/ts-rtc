import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { ServerMessage, type RoomMode, type SignalingEvent } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import { WebSocket } from 'ws';
import { buildApp, type App, type AppOptions } from '../src/app.js';
import type { Directory } from '../src/auth/directory.js';
import type { RoomAccess, RoomRecord } from '../src/db/rooms.js';
import type { User } from '../src/db/users.js';
import { createLogger } from '../src/logger.js';

/**
 * Postgres stand-in for signaling tests: the token `user:<name>` is the user `u-<name>` (display
 * name `<name>`); rooms live in a Map. db.test.ts covers the real thing.
 */
export class TestDirectory implements Directory {
  readonly rooms = new Map<string, RoomRecord & { members: Set<string> }>();

  authenticate(accessToken: string): Promise<User | undefined> {
    const name = /^user:(.+)$/.exec(accessToken)?.[1];
    return Promise.resolve(name ? { id: `u-${name}`, displayName: name } : undefined);
  }

  room(roomId: string, userId: string): Promise<RoomAccess | undefined> {
    const stored = this.rooms.get(roomId);
    if (!stored) return Promise.resolve(undefined);
    const { members, ...record } = stored;
    return Promise.resolve({ ...record, isMember: members.has(userId) });
  }

  /** A durable room (public, 10 places, owned by `u-owner` unless overridden); its id. */
  create(mode: RoomMode = 'sfu', overrides: Partial<RoomRecord> = {}): string {
    const id = randomUUID();
    this.rooms.set(id, {
      id,
      ownerId: 'u-owner',
      name: 'test room',
      visibility: 'public',
      mode,
      maxParticipants: 10,
      ...overrides,
      members: new Set(),
    });
    return id;
  }
}

/**
 * A test server; `directory` is the TestDirectory in use unless `options.directory` is given.
 * A dropped socket's member is removed after 100 ms (production: 30 s), unless overridden.
 */
export async function startServer(
  options: AppOptions = {},
  log: FastifyBaseLogger = pino({ level: 'silent' }),
) {
  const directory = new TestDirectory();
  const app: App = buildApp(log, { directory, reconnectGraceMs: 100, ...options });
  await app.http.listen({ host: '127.0.0.1', port: 0 });
  const host = `127.0.0.1:${(app.http.server.address() as AddressInfo).port}`;
  return { app, host, directory };
}

/** A real logger (redaction included) writing JSON lines into an array. */
export function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { lines, log: createLogger({ level: 'info', env: 'test', version: 'v-test' }, sink) };
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

  /** Connected and signed in as `name` (TestDirectory's token); a fresh user by default. */
  static async greeted(host: string, name = `p-${randomUUID().slice(0, 8)}`): Promise<TestClient> {
    const client = await TestClient.connect(host);
    await client.ok('session.hello', { protocolVersions: [1], accessToken: `user:${name}` });
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
