import type { RoomSnapshot } from '@ts-rtc/protocol';
import { pino } from 'pino';
import { afterEach, expect, test } from 'vitest';
import type { App } from '../src/app.js';
import { MediasoupController } from '../src/media/mediasoup/mediasoup-controller.js';
import { startServer, TestClient } from './helpers.js';

// Real Workers, no browser: the DTLS handshake never happens, so these tests check the state
// machine, the ownership rules and the cleanup, not media. Ports: see media.test.ts.
let app: App | undefined;
let media: MediasoupController | undefined;
afterEach(async () => {
  await app?.close();
  app = media = undefined;
});

async function setup(
  portBase: number,
  extra: { allowLoopback?: boolean; connectDeadlineMs?: number } = {},
) {
  media = await MediasoupController.start(
    {
      count: 1,
      listenIp: '127.0.0.1',
      announcedAddress: undefined,
      portBase,
      restartDelayMs: 50,
      maxRestartsPerMinute: 5,
      allowLoopback: extra.allowLoopback ?? true,
      connectDeadlineMs: extra.connectDeadlineMs ?? 30_000,
      iceDisconnectedMs: 30_000,
    },
    pino({ level: 'silent' }),
  );
  const server = await startServer({ media });
  app = server.app;
  const join = async (roomId?: string) => {
    const client = await TestClient.greeted(server.host);
    roomId ??= server.directory.create('sfu');
    const snapshot = await client.ok<RoomSnapshot>('room.join', { roomId });
    return { client, snapshot, roomId };
  };
  return { media, join, directory: server.directory };
}

const fakeDtls = {
  role: 'client',
  fingerprints: [{ algorithm: 'sha-256', value: Array(32).fill('AB').join(':') }],
};
const opus = {
  mid: '0',
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: 111,
      clockRate: 48_000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  headerExtensions: [],
  encodings: [{ ssrc: 11_111_111 }],
  rtcp: { cname: 'test' },
};
type Transport = {
  transportId: string;
  iceParameters: object;
  iceCandidates: object[];
  dtlsParameters: object;
};

test('one send and one recv transport per participant; a second of a kind is a conflict', async () => {
  const { media, join } = await setup(22_000);
  const { client } = await join();
  const send = await client.ok<Transport>('sfu.createTransport', { direction: 'send' });
  // The WebRtcServer's address and port, UDP and TCP: what the browser will send ICE checks to.
  expect(send.iceCandidates).toMatchObject([
    { protocol: 'udp', address: '127.0.0.1', port: 22_000 },
    { protocol: 'tcp', address: '127.0.0.1', port: 22_000 },
  ]);
  expect(Object.keys(send.iceParameters)).toContain('usernameFragment');
  expect(Object.keys(send.dtlsParameters)).toContain('fingerprints');
  await client.ok('sfu.createTransport', { direction: 'recv' });
  const again = await client.request('sfu.createTransport', { direction: 'send' });
  expect(again).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(again.ok || again.error.message).toContain(send.transportId);
  expect(media.counts().transports).toBe(2);
});

test('connect: own transport only, once; bad parameters are a payload error', async () => {
  const { join } = await setup(22_010);
  const alice = await join();
  const bob = await join(alice.roomId);
  const { transportId } = await alice.client.ok<Transport>('sfu.createTransport', {
    direction: 'send',
  });
  // Bob cannot touch Alice's transport; it looks like it does not exist.
  expect(
    await bob.client.request('sfu.connectTransport', { transportId, dtlsParameters: fakeDtls }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(
    await alice.client.request('sfu.connectTransport', { transportId, dtlsParameters: {} }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  await alice.client.ok('sfu.connectTransport', { transportId, dtlsParameters: fakeDtls });
  expect(
    await alice.client.request('sfu.connectTransport', { transportId, dtlsParameters: fakeDtls }),
  ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
});

test('produce on send, consume on recv, in the same room only; own Producer only in loopback', async () => {
  const { join } = await setup(22_020, { allowLoopback: false });
  const alice = await join();
  const bob = await join(alice.roomId);
  const stranger = await join(); // another room
  const caps = alice.snapshot.routerRtpCapabilities;
  const send = await alice.client.ok<Transport>('sfu.createTransport', { direction: 'send' });
  const recv = await alice.client.ok<Transport>('sfu.createTransport', { direction: 'recv' });
  expect(
    await alice.client.request('sfu.produce', {
      transportId: recv.transportId,
      kind: 'audio',
      source: 'mic',
      rtpParameters: opus,
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } }); // not a send transport
  const { producerId } = await alice.client.ok<{ producerId: string }>('sfu.produce', {
    transportId: send.transportId,
    kind: 'audio',
    source: 'mic',
    rtpParameters: opus,
  });

  const consume = (who: typeof alice, transportId: string) =>
    who.client.request('sfu.consume', { transportId, producerId, rtpCapabilities: caps });
  expect(await consume(alice, recv.transportId)).toMatchObject({
    ok: false,
    error: { code: 'FORBIDDEN' }, // loopback is off
  });
  const bobRecv = await bob.client.ok<Transport>('sfu.createTransport', { direction: 'recv' });
  expect(await consume(bob, bobRecv.transportId)).toMatchObject({
    ok: true,
    payload: { producerId, kind: 'audio' },
  });
  const theirRecv = await stranger.client.ok<Transport>('sfu.createTransport', {
    direction: 'recv',
  });
  expect(await consume(stranger, theirRecv.transportId)).toMatchObject({
    ok: false,
    error: { code: 'NOT_FOUND' }, // a Producer in another room does not exist for you
  });
});

test('leaving, disconnecting and Worker death all bring the counts back to zero', async () => {
  const { media, join } = await setup(22_030);
  const fill = async (who: Awaited<ReturnType<typeof join>>) => {
    const send = await who.client.ok<Transport>('sfu.createTransport', { direction: 'send' });
    const recv = await who.client.ok<Transport>('sfu.createTransport', { direction: 'recv' });
    const { producerId } = await who.client.ok<{ producerId: string }>('sfu.produce', {
      transportId: send.transportId,
      kind: 'audio',
      source: 'mic',
      rtpParameters: opus,
    });
    await who.client.ok('sfu.consume', {
      transportId: recv.transportId,
      producerId,
      rtpCapabilities: who.snapshot.routerRtpCapabilities,
    });
  };
  const alice = await join();
  await fill(alice);
  expect(media.counts()).toEqual({ transports: 2, producers: 1, consumers: 1 });
  await alice.client.ok('room.leave', {});
  expect(media.counts()).toEqual({ transports: 0, producers: 0, consumers: 0 });

  const bob = await join();
  await fill(bob);
  bob.client.close();
  await expect.poll(() => media.counts()).toEqual({ transports: 0, producers: 0, consumers: 0 });

  const carol = await join();
  await fill(carol);
  const [worker] = await media.inspect();
  process.kill(worker?.pid ?? Number.NaN, 'SIGKILL');
  await carol.client.waitForEvent('room.closed');
  expect(media.counts()).toEqual({ transports: 0, producers: 0, consumers: 0 });
});

test('a create queued behind a leave gets nothing; no transport is left behind', async () => {
  const { media, join } = await setup(22_040);
  const { client } = await join();
  const [left, created] = await Promise.all([
    client.request('room.leave', {}),
    client.request('sfu.createTransport', { direction: 'send' }),
  ]);
  expect(left.ok).toBe(true);
  expect(created).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
  expect(media.counts().transports).toBe(0);
});

test('a transport not connected within the deadline is closed and its owner is told', async () => {
  const { media, join } = await setup(22_050, { connectDeadlineMs: 200 });
  const { client } = await join();
  const { transportId } = await client.ok<Transport>('sfu.createTransport', { direction: 'recv' });
  expect(await client.waitForEvent('sfu.transportClosed')).toMatchObject({
    payload: { transportId, reason: 'connect_timeout' },
  });
  expect(media.counts().transports).toBe(0);
  // The direction is free again.
  await client.ok('sfu.createTransport', { direction: 'recv' });
});

test('SFU requests outside an SFU room are refused', async () => {
  const { join, directory } = await setup(22_060);
  const { client } = await join();
  await client.ok('room.leave', {});
  const roomId = directory.create('mesh');
  await client.ok('room.join', { roomId });
  expect(await client.request('sfu.createTransport', { direction: 'send' })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_STATE' },
  });
});
