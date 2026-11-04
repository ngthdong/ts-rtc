import type { ProducerInfo, RoomSnapshot } from '@ts-rtc/protocol';
import { pino } from 'pino';
import { afterEach, expect, test } from 'vitest';
import type { App } from '../src/app.js';
import { MediasoupController } from '../src/media/mediasoup/mediasoup-controller.js';
import { startServer, TestClient } from './helpers.js';

// Several participants in one SFU room, real Workers, scripted RTP-less Producers.
// Ports: see media.test.ts.
let app: App | undefined;
let media: MediasoupController | undefined;
afterEach(async () => {
  await app?.close();
  app = media = undefined;
});

const rtp = (kind: 'audio' | 'video', ssrc: number) => ({
  mid: String(ssrc), // unique per Producer on a transport
  codecs: [
    kind === 'audio'
      ? { mimeType: 'audio/opus', payloadType: 111, clockRate: 48_000, channels: 2 }
      : { mimeType: 'video/VP8', payloadType: 96, clockRate: 90_000 },
  ].map((c) => ({ ...c, parameters: {}, rtcpFeedback: [] })),
  headerExtensions: [],
  encodings: [{ ssrc }],
  rtcp: { cname: `c${String(ssrc)}` },
});

async function setup(portBase: number) {
  media = await MediasoupController.start(
    {
      count: 1,
      listenIp: '127.0.0.1',
      announcedAddress: undefined,
      portBase,
      restartDelayMs: 50,
      maxRestartsPerMinute: 5,
      allowLoopback: false,
      connectDeadlineMs: 30_000,
      iceDisconnectedMs: 30_000,
    },
    pino({ level: 'silent' }),
  );
  const server = await startServer({ media });
  app = server.app;
  let roomId: string | undefined;
  let ssrc = 1000;
  /** A member with a send and a recv transport. */
  const member = async () => {
    const client = await TestClient.greeted(server.host);
    roomId ??= server.directory.create('sfu');
    const snapshot = await client.ok<RoomSnapshot>('room.join', { roomId });
    const send = await client.ok<{ transportId: string }>('sfu.createTransport', {
      direction: 'send',
    });
    const recv = await client.ok<{ transportId: string }>('sfu.createTransport', {
      direction: 'recv',
    });
    const produce = (kind: 'audio' | 'video', source = kind === 'audio' ? 'mic' : 'camera') =>
      client.request('sfu.produce', {
        transportId: send.transportId,
        kind,
        source,
        rtpParameters: rtp(kind, ++ssrc),
      });
    const consume = (producerId: string) =>
      client.request('sfu.consume', {
        transportId: recv.transportId,
        producerId,
        rtpCapabilities: snapshot.routerRtpCapabilities,
      });
    return {
      client,
      snapshot,
      produce,
      consume,
      id: snapshot.participantId,
      recvId: recv.transportId,
    };
  };
  return { media, member };
}

const ok = <T>(response: { ok: boolean; payload?: unknown }) => {
  expect(response.ok).toBe(true);
  return response.payload as T;
};

test('a new Producer is announced to the others (not its owner); late joiners get it in the snapshot', async () => {
  const { member } = await setup(22_100);
  const alice = await member();
  const bob = await member();
  const { producerId } = ok<{ producerId: string }>(await alice.produce('audio'));
  expect(await bob.client.waitForEvent('sfu.newProducer')).toMatchObject({
    payload: { producerId, participantId: alice.id, kind: 'audio', source: 'mic' },
  });
  expect(alice.client.events.some((e) => e.type === 'sfu.newProducer')).toBe(false);

  const carol = await member();
  expect(carol.snapshot.producers).toEqual<ProducerInfo[]>([
    { producerId, participantId: alice.id, kind: 'audio', source: 'mic' },
  ]);
});

test('one Producer per source, and the source must match the kind', async () => {
  const { member } = await setup(22_110);
  const alice = await member();
  ok(await alice.produce('audio'));
  expect(await alice.produce('audio')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(await alice.produce('video', 'mic')).toMatchObject({
    ok: false,
    error: { code: 'INVALID_PAYLOAD' },
  });
  ok(await alice.produce('video'));
});

test('consumers start paused; only their owner resumes them; a second consume is a conflict', async () => {
  const { member } = await setup(22_120);
  const alice = await member();
  const bob = await member();
  const carol = await member();
  const { producerId } = ok<{ producerId: string }>(await alice.produce('video'));
  const consumer = ok<{ consumerId: string; producerPaused: boolean }>(
    await bob.consume(producerId),
  );
  expect(consumer.producerPaused).toBe(false);
  const again = await bob.consume(producerId);
  expect(again).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(again.ok || again.error.message).toContain(consumer.consumerId);
  expect(
    await carol.client.request('sfu.resumeConsumer', { consumerId: consumer.consumerId }),
  ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } }); // not Carol's
  await bob.client.ok('sfu.resumeConsumer', { consumerId: consumer.consumerId });
  expect(await alice.consume(producerId)).toMatchObject({
    ok: false,
    error: { code: 'FORBIDDEN' }, // own Producer, loopback off
  });
});

test('only the owner pauses a Producer; new Consumers then start with producerPaused', async () => {
  const { member } = await setup(22_130);
  const alice = await member();
  const bob = await member();
  const { producerId } = ok<{ producerId: string }>(await alice.produce('audio'));
  expect(await bob.client.request('sfu.pauseProducer', { producerId, paused: true })).toMatchObject(
    { ok: false, error: { code: 'FORBIDDEN' } }, // the policy: owner-scoped
  );
  await alice.client.ok('sfu.pauseProducer', { producerId, paused: true });
  expect(ok<{ producerPaused: boolean }>(await bob.consume(producerId)).producerPaused).toBe(true);
});

test('when a member leaves, the others are told their Consumers closed; nothing is left', async () => {
  const { media, member } = await setup(22_140);
  const alice = await member();
  const bob = await member();
  const carol = await member();
  const mic = ok<{ producerId: string }>(await alice.produce('audio')).producerId;
  const cam = ok<{ producerId: string }>(await alice.produce('video')).producerId;
  const consumed = [];
  for (const who of [bob, carol]) {
    for (const producerId of [mic, cam]) {
      consumed.push(ok<{ consumerId: string }>(await who.consume(producerId)).consumerId);
    }
  }
  expect(media.counts()).toEqual({ transports: 6, producers: 2, consumers: 4 });

  await alice.client.ok('room.leave', {});
  const closed = [];
  for (const who of [bob, carol]) {
    for (let i = 0; i < 2; i++) {
      const event = await who.client.waitForEvent('sfu.consumerClosed');
      expect(event).toMatchObject({ payload: { reason: 'producer_closed' } });
      closed.push((event.payload as { consumerId: string }).consumerId);
    }
  }
  expect(closed.sort()).toEqual(consumed.sort());
  expect(media.counts()).toEqual({ transports: 4, producers: 0, consumers: 0 });
});

test('race: the Producer closes while consume waits for the Worker (both orders)', async () => {
  const { media, member } = await setup(22_150);
  const outcomes: string[] = [];
  // Straight against the media module: through signaling, the room executor serializes these.
  for (const order of ['close, then consume', 'consume, then close'] as const) {
    const alice = await member();
    const bob = await member();
    const { producerId } = ok<{ producerId: string }>(await alice.produce('audio'));
    const caps = bob.snapshot.routerRtpCapabilities ?? {};
    if (order === 'close, then consume') media.closeParticipant(alice.id);
    const pending = media.consume(bob.id, bob.recvId, producerId, caps);
    if (order === 'consume, then close') media.closeParticipant(alice.id);
    const outcome = await pending.then(
      () => 'consumer created, then sfu.consumerClosed',
      (err: { code?: string }) => `rejected ${err.code ?? '?'}`,
    );
    if (outcome.startsWith('consumer')) await bob.client.waitForEvent('sfu.consumerClosed');
    else expect(outcome).toBe('rejected NOT_FOUND');
    expect(media.counts().consumers).toBe(0); // either way: no Consumer left registered
    outcomes.push(`${order}: ${outcome}`);
    await bob.client.ok('room.leave', {});
    await alice.client.ok('room.leave', {});
  }
  console.log(outcomes.join('\n'));
});

test('one screen sharer per room: the lock is the Producer, released by stop or leave', async () => {
  const { media, member } = await setup(22_160);
  const alice = await member();
  const bob = await member();
  const carol = await member();
  const screen = ok<{ producerId: string }>(await alice.produce('video', 'screen')).producerId;
  ok(await bob.produce('video')); // a camera is not a screen: no conflict
  const second = await bob.produce('video', 'screen');
  expect(second).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(second.ok || second.error.message).toContain(alice.id); // who is sharing

  const { consumerId } = ok<{ consumerId: string }>(await carol.consume(screen));
  expect(await bob.client.request('sfu.closeProducer', { producerId: screen })).toMatchObject({
    ok: false,
    error: { code: 'FORBIDDEN' },
  }); // not Bob's to stop
  await alice.client.ok('sfu.closeProducer', { producerId: screen });
  expect(await carol.client.waitForEvent('sfu.consumerClosed')).toMatchObject({
    payload: { consumerId },
  });

  ok(await bob.produce('video', 'screen')); // released by stopping
  bob.client.close(); // released by leaving (here: disconnecting)
  await expect.poll(() => media.counts().producers).toBe(0); // Bob's camera and screen gone
  ok(await carol.produce('video', 'screen'));
});
