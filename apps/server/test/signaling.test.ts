import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ServerMessage } from '@ts-rtc/protocol';
import { pino } from 'pino';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp, type App } from '../src/app.js';
import type { SignalingOptions } from '../src/signaling.js';

let app: App | undefined;
let host = '';
afterEach(() => app?.close());

async function start(options: Partial<SignalingOptions> = {}): Promise<void> {
  app = buildApp(pino({ level: 'silent' }), options);
  await app.http.listen({ host: '127.0.0.1', port: 0 });
  host = `127.0.0.1:${(app.http.server.address() as AddressInfo).port}`;
}

async function connect(
  options: { path?: string; origin?: string; autoPong?: boolean } = {},
): Promise<WebSocket> {
  const { path = '/ws', origin, autoPong = true } = options;
  const ws = new WebSocket(`ws://${host}${path}`, { autoPong, ...(origin ? { origin } : {}) });
  await once(ws, 'open');
  return ws;
}

let nextId = 0;
async function request(ws: WebSocket, type: string, payload: unknown, id = String(++nextId)) {
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ v: 1, kind: 'req', id, type, payload }));
  const [data] = (await reply) as [Buffer];
  return JSON.parse(data.toString()) as ServerMessage;
}

async function greet(ws: WebSocket) {
  return request(ws, 'session.hello', { protocolVersions: [1] });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', resolve));
}

test('health endpoints answer 200', async () => {
  await start();
  expect((await fetch(`http://${host}/healthz`)).status).toBe(200);
  expect((await fetch(`http://${host}/readyz`)).status).toBe(200);
});

test('hello returns a welcome, then heartbeats are answered', async () => {
  await start();
  const ws = await connect();
  const welcome = await greet(ws);
  expect(welcome).toMatchObject({ kind: 'res', ok: true, type: 'session.hello' });
  expect(welcome).toHaveProperty('payload.protocolVersion', 1);
  expect(welcome).toHaveProperty('payload.heartbeatIntervalMs', 10_000);
  const ack = await request(ws, 'session.heartbeat', {}, 'hb-1');
  expect(ack).toMatchObject({ id: 'hb-1', ok: true });
  ws.close();
});

test('requests before hello are rejected with INVALID_STATE', async () => {
  await start();
  const ws = await connect();
  const reply = await request(ws, 'session.heartbeat', {}, 'early');
  expect(reply).toMatchObject({ id: 'early', ok: false, error: { code: 'INVALID_STATE' } });
  ws.close();
});

test('unknown types and bad payloads get error responses with the request id', async () => {
  await start();
  const ws = await connect();
  await greet(ws);
  const unknown = await request(ws, 'nope', {}, 'u1');
  expect(unknown).toMatchObject({ id: 'u1', ok: false, error: { code: 'UNKNOWN_TYPE' } });
  const bad = await request(ws, 'session.heartbeat', 'not an object', 'b1');
  expect(bad).toMatchObject({ id: 'b1', ok: false, error: { code: 'INVALID_PAYLOAD' } });
  ws.close();
});

test('a repeated request id gets the cached response instead of running again', async () => {
  await start();
  const ws = await connect();
  await greet(ws);
  const first = await request(ws, 'session.heartbeat', {}, 'same');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await request(ws, 'session.heartbeat', {}, 'same');
  expect(second).toEqual(first);
  ws.close();
});

test('an unsupported version gets an error, then close 4400', async () => {
  await start();
  const ws = await connect();
  const closed = closeCode(ws);
  const reply = await request(ws, 'session.hello', { protocolVersions: [2] });
  expect(reply).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
  expect(await closed).toBe(4400);
});

test('no hello before the deadline closes with 4408', async () => {
  await start({ helloTimeoutMs: 50 });
  const ws = await connect();
  expect(await closeCode(ws)).toBe(4408);
});

test('a client that stops answering pings is terminated', async () => {
  await start({ pingIntervalMs: 30 });
  const ws = await connect({ autoPong: false });
  expect(await closeCode(ws)).toBe(1006);
});

test('upgrades are refused on other paths and from foreign origins', async () => {
  await start();
  await expect(connect({ path: '/nope' })).rejects.toThrow(/404/);
  await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow(/403/);
  const ok = await connect({ origin: 'http://localhost:5173' });
  ok.close();
});

test.each([
  ['invalid JSON', '{not json', 1007],
  ['an envelope without id', JSON.stringify({ v: 1, kind: 'req', type: 'x', payload: {} }), 1007],
  ['an oversized frame', 'x'.repeat(70 * 1024), 1009],
  ['a binary frame', Buffer.from([1, 2, 3]), 1003],
])('closes on %s', async (_name, frame, code) => {
  await start();
  const ws = await connect();
  const closed = closeCode(ws);
  ws.send(frame);
  expect(await closed).toBe(code);
});

test('shutdown closes clients with 1001 and stops listening', async () => {
  await start();
  const ws = await connect();
  const closed = closeCode(ws);
  await app?.close();
  expect(await closed).toBe(1001);
  await expect(fetch(`http://${host}/healthz`)).rejects.toThrow();
});
