import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp, type App } from '../src/app.js';

let app: App;
let host: string;

beforeEach(async () => {
  app = buildApp(pino({ level: 'silent' }));
  await app.http.listen({ host: '127.0.0.1', port: 0 });
  host = `127.0.0.1:${(app.http.server.address() as AddressInfo).port}`;
});
afterEach(() => app.close());

async function connect(path = '/ws'): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${host}${path}`);
  await once(ws, 'open');
  return ws;
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', resolve));
}

test('health endpoints answer 200', async () => {
  expect((await fetch(`http://${host}/healthz`)).status).toBe(200);
  expect((await fetch(`http://${host}/readyz`)).status).toBe(200);
});

test('echoes debug.echo with a per-connection sessionId', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'debug.echo', payload: 'hello' }));
  const [data] = (await once(ws, 'message')) as [Buffer];
  const reply = JSON.parse(data.toString()) as { payload: string; sessionId: string };
  expect(reply.payload).toBe('hello');
  expect(reply.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  ws.close();
});

test('rejects upgrades on other paths with 404', async () => {
  await expect(connect('/nope')).rejects.toThrow(/404/);
});

test.each([
  ['invalid JSON', '{not json', 1007],
  ['unknown message', JSON.stringify({ type: 'nope' }), 1007],
  ['oversized frame', 'x'.repeat(70 * 1024), 1009],
])('closes on %s', async (_name, frame, code) => {
  const ws = await connect();
  const closed = closeCode(ws);
  ws.send(frame);
  expect(await closed).toBe(code);
});

test('closes on binary frames with 1003', async () => {
  const ws = await connect();
  const closed = closeCode(ws);
  ws.send(Buffer.from([1, 2, 3]));
  expect(await closed).toBe(1003);
});

test('shutdown closes clients with 1001 and stops listening', async () => {
  const ws = await connect();
  const closed = closeCode(ws);
  await app.close();
  expect(await closed).toBe(1001);
  await expect(fetch(`http://${host}/healthz`)).rejects.toThrow();
});
