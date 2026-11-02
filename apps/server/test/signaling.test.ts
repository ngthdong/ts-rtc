import { afterEach, expect, test } from 'vitest';
import type { App } from '../src/app.js';
import type { SignalingOptions } from '../src/signaling.js';
import { startServer, TestClient } from './helpers.js';

let app: App | undefined;
let host = '';
afterEach(() => app?.close());

async function start(options: Partial<SignalingOptions> = {}): Promise<void> {
  ({ app, host } = await startServer(options));
}

test('health endpoints answer 200', async () => {
  await start();
  expect((await fetch(`http://${host}/healthz`)).status).toBe(200);
  expect((await fetch(`http://${host}/readyz`)).status).toBe(200);
});

test('hello returns a welcome, then heartbeats are answered', async () => {
  await start({ iceServersFor: (key) => [{ urls: 'turn:t', username: key, credential: 'c' }] });
  const client = await TestClient.connect(host);
  const welcome = await client.request('session.hello', { protocolVersions: [1] });
  expect(welcome).toMatchObject({ kind: 'res', ok: true, type: 'session.hello' });
  expect(welcome).toHaveProperty('payload.protocolVersion', 1);
  expect(welcome).toHaveProperty('payload.heartbeatIntervalMs', 10_000);
  const sessionId = welcome.ok ? (welcome.payload as { sessionId: string }).sessionId : '';
  expect(welcome).toHaveProperty('payload.iceServers', [
    { urls: 'turn:t', username: sessionId, credential: 'c' },
  ]);
  const ack = await client.request('session.heartbeat', {}, 'hb-1');
  expect(ack).toMatchObject({ id: 'hb-1', ok: true });
  client.close();
});

test('requests before hello are rejected with INVALID_STATE', async () => {
  await start();
  const client = await TestClient.connect(host);
  const reply = await client.request('session.heartbeat', {}, 'early');
  expect(reply).toMatchObject({ id: 'early', ok: false, error: { code: 'INVALID_STATE' } });
  client.close();
});

test('unknown types and bad payloads get error responses with the request id', async () => {
  await start();
  const client = await TestClient.greeted(host);
  const unknown = await client.request('nope', {}, 'u1');
  expect(unknown).toMatchObject({ id: 'u1', ok: false, error: { code: 'UNKNOWN_TYPE' } });
  const bad = await client.request('session.heartbeat', 'not an object', 'b1');
  expect(bad).toMatchObject({ id: 'b1', ok: false, error: { code: 'INVALID_PAYLOAD' } });
  client.close();
});

test('a repeated request id gets the cached response instead of running again', async () => {
  await start();
  const client = await TestClient.greeted(host);
  const first = await client.request('session.heartbeat', {}, 'same');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await client.request('session.heartbeat', {}, 'same');
  expect(second).toEqual(first);
  client.close();
});

test('an unsupported version gets an error, then close 4400', async () => {
  await start();
  const client = await TestClient.connect(host);
  const reply = await client.request('session.hello', { protocolVersions: [2] });
  expect(reply).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
  expect(await client.closed).toBe(4400);
});

test('no hello before the deadline closes with 4408', async () => {
  await start({ helloTimeoutMs: 50 });
  const client = await TestClient.connect(host);
  expect(await client.closed).toBe(4408);
});

test('a client that stops answering pings is terminated', async () => {
  await start({ pingIntervalMs: 30 });
  const client = await TestClient.connect(host, { autoPong: false });
  expect(await client.closed).toBe(1006);
});

test('upgrades are refused on other paths and from foreign origins', async () => {
  await start();
  await expect(TestClient.connect(host, { path: '/nope' })).rejects.toThrow(/404/);
  await expect(TestClient.connect(host, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
  const ok = await TestClient.connect(host, { origin: 'http://localhost:5173' });
  ok.close();
});

test.each([
  ['invalid JSON', '{not json', 1007],
  ['an envelope without id', JSON.stringify({ v: 1, kind: 'req', type: 'x', payload: {} }), 1007],
  ['an oversized frame', 'x'.repeat(70 * 1024), 1009],
  ['a binary frame', Buffer.from([1, 2, 3]), 1003],
])('closes on %s', async (_name, frame, code) => {
  await start();
  const client = await TestClient.connect(host);
  client.send(frame);
  expect(await client.closed).toBe(code);
});

test('shutdown closes clients with 1001 and stops listening', async () => {
  await start();
  const client = await TestClient.connect(host);
  await app?.close();
  expect(await client.closed).toBe(1001);
  await expect(fetch(`http://${host}/healthz`)).rejects.toThrow();
});
