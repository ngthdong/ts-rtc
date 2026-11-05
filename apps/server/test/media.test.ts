import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { RoomSnapshot } from '@ts-rtc/protocol';
import { pino } from 'pino';
import { afterEach, expect, test } from 'vitest';
import type { App } from '../src/app.js';
import type { MediaController } from '../src/media/media-controller.js';
import { MediasoupController } from '../src/media/mediasoup/mediasoup-controller.js';
import type { TransportOptions } from '../src/media/mediasoup/transport-service.js';
import type { WorkerPoolOptions } from '../src/media/mediasoup/worker-pool.js';
import { startServer, TestClient, type TestDirectory } from './helpers.js';

// Real mediasoup-worker processes. Each test uses its own ports: a killed Worker's sockets
// may still be closing when the next test starts. All below 32768: Linux hands out client ports
// from 32768 up, and a test's own WebSocket on one of them would make the Worker's bind fail.
const silent = pino({ level: 'silent' });
type MediaOptions = WorkerPoolOptions & TransportOptions;
const options = (portBase: number, extra: Partial<MediaOptions> = {}): MediaOptions => ({
  count: 2,
  listenIp: '127.0.0.1',
  announcedAddress: undefined,
  portBase,
  restartDelayMs: 50,
  maxRestartsPerMinute: 5,
  allowLoopback: true,
  connectDeadlineMs: 30_000,
  iceDisconnectedMs: 30_000,
  ...extra,
});

let media: MediaController | undefined;
let app: App | undefined;
afterEach(async () => {
  await app?.close(); // closes media too
  media?.close();
  app = media = undefined;
});

async function startMedia(portBase: number, extra: Partial<MediaOptions> = {}) {
  const controller = await MediasoupController.start(options(portBase, extra), silent);
  media = controller;
  return controller;
}

let directory: TestDirectory;
/** Starts the signaling server (with `media` if given); returns its host. */
async function serve(opts: Parameters<typeof startServer>[0] = {}): Promise<string> {
  const server = await startServer(opts);
  app = server.app;
  directory = server.directory;
  return server.host;
}

/** SIGKILL, as a crash or the OOM killer would. Never pid 0: that is our process group. */
function kill(pid: number | undefined): void {
  if (!pid) throw new Error('no such Worker');
  process.kill(pid, 'SIGKILL');
}

const routerCounts = async (m: MediaController) =>
  (await m.inspect()).map((w) => w.routerIds.length);

async function bindFails(port: number, protocol: 'udp' | 'tcp'): Promise<string> {
  const socket = protocol === 'udp' ? createSocket('udp4') : createServer();
  if (protocol === 'udp') (socket as ReturnType<typeof createSocket>).bind(port, '127.0.0.1');
  else (socket as ReturnType<typeof createServer>).listen(port, '127.0.0.1');
  const [err] = (await Promise.race([
    once(socket, 'error'),
    once(socket, 'listening').then(() => [new Error('bound')]),
  ])) as [NodeJS.ErrnoException];
  socket.close();
  return err.code ?? err.message;
}

test('starts N Workers, each with a WebRtcServer on its own UDP and TCP port', async () => {
  const m = await startMedia(21_000);
  const workers = await m.inspect();
  expect(workers.map((w) => w.index)).toEqual([0, 1]);
  expect(new Set(workers.map((w) => w.pid)).size).toBe(2);
  for (const port of [21_000, 21_001]) {
    expect(await bindFails(port, 'udp')).toBe('EADDRINUSE');
    expect(await bindFails(port, 'tcp')).toBe('EADDRINUSE');
  }
  expect(workers[0]?.usage.ru_maxrss).toBeGreaterThan(0); // getResourceUsage() works
});

test('50 concurrent ensureRouter calls for one room create one Router', async () => {
  const m = await startMedia(21_010);
  const all = await Promise.all(Array.from({ length: 50 }, () => m.ensureRouter('room-a')));
  expect(new Set(all.map((caps) => JSON.stringify(caps))).size).toBe(1);
  expect(await routerCounts(m)).toEqual([1, 0]);
  const mimeTypes = (all[0]?.codecs as { mimeType: string }[]).map((c) => c.mimeType);
  expect(mimeTypes).toEqual(expect.arrayContaining(['audio/opus', 'video/VP8', 'video/H264']));
});

test('Routers go to the least-loaded Worker; closing frees the slot', async () => {
  const m = await startMedia(21_020);
  for (const room of ['a', 'b', 'c']) await m.ensureRouter(room);
  expect(await routerCounts(m)).toEqual([2, 1]);
  m.closeRouter('a');
  m.closeRouter('a'); // idempotent
  await expect.poll(() => routerCounts(m)).toEqual([1, 1]);
  await m.ensureRouter('d');
  expect(await routerCounts(m)).toEqual([2, 1]);
});

test('a Router closed while still being created is closed as soon as it exists', async () => {
  const m = await startMedia(21_030);
  const pending = m.ensureRouter('x');
  m.closeRouter('x');
  await pending;
  await expect.poll(() => routerCounts(m)).toEqual([0, 0]);
});

test('a Worker dying during createRouter fails with a retryable error', async () => {
  const m = await startMedia(21_040, { count: 1, restartDelayMs: 60_000 });
  const [worker] = await m.inspect();
  // Killed first, so the Worker cannot answer in time; Node has not seen 'died' yet (no await
  // in between), so from its point of view the Worker dies while the request is in flight.
  kill(worker?.pid);
  const pending = m.ensureRouter('r');
  await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
});

test('SFU join returns the Router capabilities; two first joins at once make one Router', async () => {
  const m = await startMedia(21_050);
  const server = await serve({ media: m });
  const alice = await TestClient.greeted(server);
  const bob = await TestClient.greeted(server);
  const roomId = directory.create('sfu');
  const [a, b] = await Promise.all([
    alice.ok<RoomSnapshot>('room.join', { roomId }),
    bob.ok<RoomSnapshot>('room.join', { roomId }),
  ]);
  expect(a.mode).toBe('sfu');
  expect(a.routerRtpCapabilities).toEqual(b.routerRtpCapabilities);
  expect(a.routerRtpCapabilities?.codecs).toBeDefined();
  expect(await routerCounts(m)).toEqual([1, 0]);
});

test('a room that closes (empty grace over) closes its Router', async () => {
  const m = await startMedia(21_060);
  const server = await serve({ media: m, emptyGraceMs: 50 });
  const alice = await TestClient.greeted(server);
  const roomId = directory.create('sfu');
  await alice.ok('room.join', { roomId });
  expect(await routerCounts(m)).toEqual([1, 0]);
  await alice.ok('room.leave', {});
  await expect.poll(() => routerCounts(m)).toEqual([0, 0]);
});

test('a dead Worker: its rooms move to a new Router, members are told, a replacement starts', async () => {
  const m = await startMedia(21_070);
  const server = await serve({ media: m });
  const alice = await TestClient.greeted(server);
  const bob = await TestClient.greeted(server);
  const roomA = directory.create('sfu');
  const roomB = directory.create('sfu');
  const a = await alice.ok<RoomSnapshot>('room.join', { roomId: roomA }); // Worker 0
  await bob.ok('room.join', { roomId: roomB }); // Worker 1
  const [first, second] = await m.inspect();

  kill(first?.pid);
  const reset = await alice.waitForEvent('sfu.mediaReset');
  const synced = await alice.ok<RoomSnapshot>('room.sync', {}); // still a member
  expect(synced).toMatchObject({ roomId: roomA, participantId: a.participantId });
  expect(synced.routerId).not.toBe(a.routerId);
  expect(reset.payload).toEqual({ routerRtpCapabilities: synced.routerRtpCapabilities });
  expect(alice.events.some((e) => e.type === 'room.closed')).toBe(false);
  expect(await bob.ok<RoomSnapshot>('room.sync', {})).toMatchObject({ roomId: roomB });
  expect(bob.events.some((e) => e.type === 'sfu.mediaReset')).toBe(false);

  const replaced = async () => {
    const worker = (await m.inspect()).find((w) => w.index === 0);
    return worker !== undefined && worker.pid !== first?.pid;
  };
  await expect.poll(replaced).toBe(true);
  expect((await m.inspect())[1]?.pid).toBe(second?.pid); // the other Worker was untouched
  expect(await routerCounts(m)).toEqual([0, 2]); // room A moved to the live Worker
  expect((await app?.http.inject('/readyz'))?.statusCode).toBe(200);
});

test('a dead Worker and no other: the room waits for the replacement Worker', async () => {
  const m = await startMedia(21_075, { count: 1, restartDelayMs: 300 });
  const server = await serve({ media: m });
  const alice = await TestClient.greeted(server);
  await alice.ok('room.join', { roomId: directory.create('sfu') });
  const [worker] = await m.inspect();
  kill(worker?.pid);
  await alice.waitForEvent('sfu.mediaReset');
  const [replacement] = await m.inspect();
  expect(replacement?.pid).not.toBe(worker?.pid);
  expect(replacement?.routerIds).toHaveLength(1);
});

test('a second media reset within a minute closes the room instead', async () => {
  const m = await startMedia(21_085, { count: 2 });
  const server = await serve({ media: m });
  const alice = await TestClient.greeted(server);
  await alice.ok('room.join', { roomId: directory.create('sfu') });
  const host = async () => (await m.inspect()).find((w) => w.routerIds.length > 0)?.pid;
  kill(await host());
  await alice.waitForEvent('sfu.mediaReset');
  kill(await host());
  expect(await alice.waitForEvent('room.closed')).toMatchObject({
    payload: { reason: 'media_failure' },
  });
});

test('a crash loop (6 deaths in a minute) stops restarts and makes /readyz answer 503', async () => {
  const m = await startMedia(21_080, { count: 1, restartDelayMs: 300 });
  await serve({ media: m });
  for (let death = 0; death < 6; death++) {
    await expect.poll(async () => (await m.inspect()).length).toBe(1); // replaced
    const [worker] = await m.inspect();
    kill(worker?.pid);
    await expect.poll(async () => (await m.inspect()).length).toBe(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500)); // no seventh Worker appears
  expect(await m.inspect()).toEqual([]);
  expect(m.healthy).toBe(false);
  expect((await app?.http.inject('/readyz'))?.json()).toEqual({ status: 'media_failing' });
});

test('without a media controller, SFU rooms cannot be joined', async () => {
  const server = await serve();
  const alice = await TestClient.greeted(server);
  const roomId = directory.create('sfu');
  expect(await alice.request('room.join', { roomId })).toMatchObject({
    ok: false,
    error: { code: 'UNAVAILABLE', retryable: true },
  });
});
