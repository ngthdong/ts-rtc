import type { JoinResult, RoomSnapshot } from '@ts-rtc/protocol';
import { afterEach, expect, test } from 'vitest';
import type { App } from '../src/app.js';
import { startServer, TestClient, type TestDirectory } from './helpers.js';

let app: App | undefined;
afterEach(() => app?.close());

async function setup(reconnectGraceMs: number) {
  let directory: TestDirectory;
  let host: string;
  ({ app, host, directory } = await startServer({ reconnectGraceMs }));
  const roomId = directory.create('mesh');
  const alice = await TestClient.greeted(host, 'Alice');
  const bob = await TestClient.greeted(host, 'Bob');
  await alice.ok('room.join', { roomId });
  const b = await bob.ok<JoinResult>('room.join', { roomId });
  await alice.waitForEvent('participant.joined');
  return { host, roomId, alice, bob, b };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a dropped socket resumes the same participant; others see it come back; the token rotates', async () => {
  const { host, alice, bob, b } = await setup(5_000);
  bob.close();
  expect(await alice.waitForEvent('participant.updated')).toMatchObject({
    payload: { participantId: b.participantId, connection: 'reconnecting' },
  });

  const again = await TestClient.greeted(host, 'Bob');
  const resumed = await again.ok<JoinResult>('room.resume', { resumeToken: b.resumeToken });
  expect(resumed.participantId).toBe(b.participantId);
  expect(resumed.resumeToken).not.toBe(b.resumeToken);
  expect(resumed.members.map((m) => m.connection)).toEqual(['connected', 'connected']);
  expect(await alice.waitForEvent('participant.updated')).toMatchObject({
    payload: { participantId: b.participantId, connection: 'connected' },
  });
  expect(alice.events.some((e) => e.type === 'participant.left')).toBe(false);

  await again.ok('participant.update', { audioMuted: true, videoMuted: false }); // bound again
  const stale = await (
    await TestClient.greeted(host, 'Bob')
  ).request('room.resume', {
    resumeToken: b.resumeToken,
  });
  expect(stale).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('a normal close (1000) is a deliberate leave: removed at once, no resume', async () => {
  const { host, alice, bob, b } = await setup(5_000);
  bob.ws.close(1000);
  expect(await alice.waitForEvent('participant.left')).toMatchObject({
    payload: { participantId: b.participantId, reason: 'left' },
  });
  expect(alice.events.some((e) => e.type === 'participant.updated')).toBe(false);
  const again = await TestClient.greeted(host, 'Bob');
  const refused = await again.request('room.resume', { resumeToken: b.resumeToken });
  expect(refused).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('after the grace the member is gone: resume is NOT_FOUND, a join is a new participant', async () => {
  const { host, roomId, alice, bob, b } = await setup(100);
  bob.close();
  expect(await alice.waitForEvent('participant.left')).toMatchObject({
    payload: { participantId: b.participantId, reason: 'timeout' },
  });
  const again = await TestClient.greeted(host, 'Bob');
  const refused = await again.request('room.resume', { resumeToken: b.resumeToken });
  expect(refused).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(refused.ok || refused.error.message).toContain('join the room again');
  const rejoined = await again.ok<RoomSnapshot>('room.join', { roomId });
  expect(rejoined.participantId).not.toBe(b.participantId);
  expect(rejoined.members).toHaveLength(2);
});

test('mesh signals sent to a reconnecting member are delivered when it resumes', async () => {
  const { host, alice, bob, b } = await setup(5_000);
  bob.close();
  await alice.waitForEvent('participant.updated');
  const offer = { description: { type: 'offer', sdp: 'v=0' } };
  await alice.ok('mesh.signal', { to: b.participantId, signal: offer }); // held, not lost
  const again = await TestClient.greeted(host, 'Bob');
  await again.ok('room.resume', { resumeToken: b.resumeToken });
  expect(await again.waitForEvent('mesh.signal')).toMatchObject({ payload: { signal: offer } });
});

test('only the same user with the current secret: everything else is NOT_FOUND', async () => {
  const { host, bob, b } = await setup(5_000);
  bob.close();
  const [roomId, participantId, secret] = b.resumeToken.split('.');
  const mallory = await TestClient.greeted(host, 'Mallory');
  const attempts = [
    { client: mallory, resumeToken: b.resumeToken }, // someone else's token
    {
      client: await TestClient.greeted(host, 'Bob'),
      resumeToken: `${roomId}.${participantId}.x${secret}`,
    },
    { client: await TestClient.greeted(host, 'Bob'), resumeToken: 'not-a-token' },
    {
      client: await TestClient.greeted(host, 'Bob'),
      resumeToken: `nope.${participantId}.${secret}`,
    },
  ];
  for (const { client, resumeToken } of attempts) {
    expect(await client.request('room.resume', { resumeToken })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  }
  // Failed attempts burn nothing: the owner still gets back in.
  const again = await TestClient.greeted(host, 'Bob');
  const resumed = await again.ok<JoinResult>('room.resume', { resumeToken: b.resumeToken });
  expect(resumed.participantId).toBe(b.participantId);
});

test('a resume while the old connection is alive replaces it: session.replaced, then 4409', async () => {
  const { host, alice, bob, b } = await setup(100);
  const again = await TestClient.greeted(host, 'Bob');
  const resumed = await again.ok<JoinResult>('room.resume', { resumeToken: b.resumeToken });
  expect(resumed.participantId).toBe(b.participantId);
  expect(await bob.waitForEvent('session.replaced')).toEqual({
    type: 'session.replaced',
    payload: {},
  });
  expect(await bob.closed).toBe(4409);
  await pause(300); // past the grace: the old socket's close must not remove the member
  expect(alice.events.filter((e) => e.type.startsWith('participant.'))).toEqual([]);
  const synced = await again.ok<RoomSnapshot>('room.sync', {});
  expect(synced.members.map((m) => m.connection)).toEqual(['connected', 'connected']);
});
