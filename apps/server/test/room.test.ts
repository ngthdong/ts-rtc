import type { EventPayload, EventType, RoomSnapshot, SignalingEvent } from '@ts-rtc/protocol';
import fc from 'fast-check';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { App } from '../src/app.js';
import { SerialExecutor } from '../src/rooms/executor.js';
import { Room, type Binding, type Peer, type RoomOptions } from '../src/rooms/room.js';
import { startServer, TestClient } from './helpers.js';

let app: App;
let host: string;
beforeEach(async () => {
  ({ app, host } = await startServer());
});
afterEach(() => app.close());

async function createRoom(client: TestClient): Promise<string> {
  return (await client.ok<{ roomId: string }>('room.create', { mode: 'mesh' })).roomId;
}

test('two clients see each other join and leave', async () => {
  const alice = await TestClient.greeted(host);
  const bob = await TestClient.greeted(host);
  const roomId = await createRoom(alice);
  const a = await alice.ok<RoomSnapshot>('room.join', { roomId, displayName: 'Alice' });
  const b = await bob.ok<RoomSnapshot>('room.join', { roomId, displayName: 'Bob' });
  expect(b.members.map((m) => m.displayName)).toEqual(['Alice', 'Bob']);
  expect(await alice.waitForEvent('participant.joined')).toMatchObject({
    payload: { roomSeq: 2, participant: { participantId: b.participantId, displayName: 'Bob' } },
  });
  await bob.ok('participant.update', { audioMuted: true, videoMuted: false });
  for (const client of [alice, bob]) {
    expect(await client.waitForEvent('participant.updated')).toMatchObject({
      payload: { roomSeq: 3, participantId: b.participantId, audioMuted: true, videoMuted: false },
    });
  }

  await bob.ok('room.leave', {});
  expect(await alice.waitForEvent('participant.left')).toMatchObject({
    payload: { roomSeq: 4, participantId: b.participantId, reason: 'left' },
  });
  expect(await alice.ok<RoomSnapshot>('room.sync', {})).toMatchObject({
    roomSeq: 4,
    members: [{ participantId: a.participantId }],
  });
});

test('closing the socket removes the participant with reason "disconnected"', async () => {
  const alice = await TestClient.greeted(host);
  const bob = await TestClient.greeted(host);
  const roomId = await createRoom(alice);
  await alice.ok('room.join', { roomId, displayName: 'Alice' });
  const b = await bob.ok<RoomSnapshot>('room.join', { roomId, displayName: 'Bob' });
  bob.close();
  expect(await alice.waitForEvent('participant.left')).toMatchObject({
    payload: { participantId: b.participantId, reason: 'disconnected' },
  });
});

test('6 concurrent joins into a room of 4: exactly 4 succeed', async () => {
  const owner = await TestClient.greeted(host);
  const roomId = await createRoom(owner);
  const clients = await Promise.all(Array.from({ length: 6 }, () => TestClient.greeted(host)));
  const replies = await Promise.all(
    clients.map((c, i) => c.request('room.join', { roomId, displayName: `p${i}` })),
  );
  expect(replies.filter((r) => r.ok)).toHaveLength(4);
  const rejected = replies.filter((r) => !r.ok);
  expect(rejected).toHaveLength(2);
  for (const r of rejected) expect(r).toMatchObject({ error: { code: 'CAPACITY_EXCEEDED' } });
});

test('join rules: idempotent, one room at a time, unknown rooms, leave needs a room', async () => {
  const client = await TestClient.greeted(host);
  const roomId = await createRoom(client);
  const otherRoomId = await createRoom(client);
  const first = await client.ok<RoomSnapshot>('room.join', { roomId, displayName: 'A' });
  const again = await client.ok<RoomSnapshot>('room.join', { roomId, displayName: 'A' });
  expect(again.participantId).toBe(first.participantId);
  const other = await client.request('room.join', { roomId: otherRoomId, displayName: 'A' });
  expect(other).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  const missing = await client.request('room.join', { roomId: 'nope', displayName: 'A' });
  expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  await client.ok('room.leave', {});
  const leaveAgain = await client.request('room.leave', {});
  expect(leaveAgain).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
});

const log = pino({ level: 'silent' });
const options: RoomOptions = { capacity: 4, createdTtlMs: 60_000, emptyGraceMs: 1_000 };

class FakePeer implements Peer {
  binding: Binding | undefined;
  events: SignalingEvent[] = [];
  emit<T extends EventType>(type: T, payload: EventPayload<T>): void {
    this.events.push({ type, payload } as SignalingEvent);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SerialExecutor', () => {
  test('runs tasks in order and survives a failing task', async () => {
    const executor = new SerialExecutor();
    const order: number[] = [];
    const first = executor.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    });
    const failing = executor.run(() => {
      throw new Error('boom');
    });
    const third = executor.run(() => order.push(3));
    await first;
    await expect(failing).rejects.toThrow('boom');
    await third;
    expect(order).toEqual([1, 3]);
  });
});

describe('Room', () => {
  test('join, leave and the empty → closed lifecycle', () => {
    vi.useFakeTimers();
    const onClosed = vi.fn();
    const room = new Room(options, log, onClosed);
    const alice = new FakePeer();
    const bob = new FakePeer();
    const a = room.join(alice, 'Alice');
    const b = room.join(bob, 'Bob');
    expect(b.members.map((m) => m.displayName)).toEqual(['Alice', 'Bob']);
    expect(alice.events).toEqual([
      { type: 'participant.joined', payload: { roomSeq: 2, participant: b.members[1] } },
    ]);
    expect(bob.events).toEqual([]);
    expect(room.remove(a.participantId, 1, 'left')).toBe(true);
    expect(room.remove(a.participantId, 1, 'left')).toBe(false); // idempotent
    expect(room.remove(b.participantId, 99, 'disconnected')).toBe(false); // stale epoch
    expect(room.remove(b.participantId, 1, 'disconnected')).toBe(true);
    expect(room.state).toBe('empty');
    vi.advanceTimersByTime(options.emptyGraceMs);
    return vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledWith(room);
    });
  });

  test('joining twice returns the same participant; another room is a conflict', () => {
    const room = new Room(options, log, () => {});
    const other = new Room(options, log, () => {});
    const peer = new FakePeer();
    const first = room.join(peer, 'Alice');
    expect(room.join(peer, 'Alice').participantId).toBe(first.participantId);
    expect(() => other.join(peer, 'Alice')).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  test('the room is full at capacity', () => {
    const room = new Room({ ...options, capacity: 2 }, log, () => {});
    room.join(new FakePeer(), 'A');
    room.join(new FakePeer(), 'B');
    expect(() => room.join(new FakePeer(), 'C')).toThrow(
      expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }),
    );
  });

  test('a mute change reaches everyone, the sender included; a no-op change emits nothing', () => {
    const room = new Room(options, log, () => {});
    const alice = new FakePeer();
    const bob = new FakePeer();
    const a = room.join(alice, 'Alice');
    room.join(bob, 'Bob');
    alice.events = [];
    room.update(a.participantId, { audioMuted: true, videoMuted: false });
    const updated = {
      type: 'participant.updated',
      payload: { roomSeq: 3, participantId: a.participantId, audioMuted: true, videoMuted: false },
    };
    expect(alice.events).toEqual([updated]);
    expect(bob.events).toEqual([updated]);
    room.update(a.participantId, { audioMuted: true, videoMuted: false });
    expect(room.roomSeq).toBe(3);
    expect(room.snapshot(a.participantId).members[0]).toMatchObject({ audioMuted: true });
  });

  test('the active speaker is room state: ordered by roomSeq, deduplicated, members only', () => {
    const room = new Room(options, log, vi.fn(), 'sfu');
    const alice = new FakePeer();
    const bob = new FakePeer();
    const a = room.join(alice, 'Alice');
    const b = room.join(bob, 'Bob');
    room.setActiveSpeaker(b.participantId);
    const event = {
      type: 'sfu.activeSpeaker',
      payload: { roomSeq: 3, participantId: b.participantId },
    };
    expect(alice.events.at(-1)).toEqual(event);
    expect(bob.events.at(-1)).toEqual(event); // the speaker too: everyone shows the same tile
    room.setActiveSpeaker(b.participantId); // the same speaker again: no event
    room.setActiveSpeaker('gone'); // not (or no longer) a member: dropped
    expect(room.roomSeq).toBe(3);
    expect(alice.events).toHaveLength(2);
    expect(room.snapshot(a.participantId).activeSpeaker).toBe(b.participantId);
    room.remove(b.participantId, 1, 'left');
    expect(room.snapshot(a.participantId)).not.toHaveProperty('activeSpeaker');
  });
});

describe('Room invariants', () => {
  type Op =
    | { kind: 'join' | 'leave' | 'sync'; client: number }
    | { kind: 'disconnect'; client: number; stale: boolean }
    | { kind: 'update'; client: number; audioMuted: boolean; videoMuted: boolean };

  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constantFrom('join' as const, 'leave' as const, 'sync' as const),
      client: fc.nat(5),
    }),
    fc.record({ kind: fc.constant('disconnect' as const), client: fc.nat(5), stale: fc.boolean() }),
    fc.record({
      kind: fc.constant('update' as const),
      client: fc.nat(5),
      audioMuted: fc.boolean(),
      videoMuted: fc.boolean(),
    }),
  );

  test('hold for 1,000 random interleavings', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const room = new Room({ ...options, capacity: 4 }, log, () => {});
        const peers = Array.from({ length: 6 }, () => new FakePeer());
        const views = new Map<FakePeer, { roomSeq: number; members: Set<string> }>();

        for (const step of ops) {
          const peer = peers[step.client];
          if (!peer) continue;
          const binding = peer.binding;
          if (step.kind === 'join') {
            try {
              const snap = room.join(peer, `p${step.client}`);
              peer.events = [];
              views.set(peer, {
                roomSeq: snap.roomSeq,
                members: new Set(snap.members.map((m) => m.participantId)),
              });
            } catch (err) {
              expect(err).toMatchObject({ code: 'CAPACITY_EXCEEDED' });
            }
          } else if (binding && step.kind === 'sync') {
            expect(room.snapshot(binding.participantId).roomSeq).toBe(room.roomSeq);
          } else if (binding && step.kind === 'leave') {
            expect(room.remove(binding.participantId, binding.epoch, 'left')).toBe(true);
            views.delete(peer);
          } else if (binding && step.kind === 'update') {
            room.update(binding.participantId, step);
          } else if (binding && step.kind === 'disconnect') {
            const epoch = step.stale ? binding.epoch - 1 : binding.epoch;
            const seqBefore = room.roomSeq;
            const changed = room.remove(binding.participantId, epoch, 'disconnected');
            expect(changed).toBe(!step.stale); // a stale close is a no-op…
            if (step.stale) expect(room.roomSeq).toBe(seqBefore); // …and emits nothing
            if (changed) views.delete(peer);
          }

          // Apply events to each member's view; roomSeq must be exactly +1 each time.
          for (const [member, view] of views) {
            for (const event of member.events) {
              if (!('roomSeq' in event.payload)) continue; // not a membership event
              expect(event.payload.roomSeq).toBe(view.roomSeq + 1);
              view.roomSeq = event.payload.roomSeq;
              if (event.type === 'participant.joined') {
                view.members.add(event.payload.participant.participantId);
              } else if (event.type === 'participant.left') {
                view.members.delete(event.payload.participantId);
              }
            }
            member.events = [];
          }

          const actual = new Set(room.members.map((m) => m.participantId));
          const bound = peers.filter((p) => p.binding);
          expect(bound.length).toBe(actual.size);
          for (const p of bound) expect(actual.has(p.binding?.participantId ?? '')).toBe(true);
          for (const view of views.values()) expect(view.members).toEqual(actual);
          expect(room.state).toBe(
            actual.size > 0 ? 'active' : room.roomSeq === 0 ? 'created' : 'empty',
          );
          expect(actual.size).toBeLessThanOrEqual(4);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});

test('mesh.signal reaches only the addressed member, stamped with the real sender', async () => {
  const alice = await TestClient.greeted(host);
  const bob = await TestClient.greeted(host);
  const mallory = await TestClient.greeted(host);
  const roomId = await createRoom(alice);
  const a = await alice.ok<RoomSnapshot>('room.join', { roomId, displayName: 'Alice' });
  const b = await bob.ok<RoomSnapshot>('room.join', { roomId, displayName: 'Bob' });
  await mallory.ok('room.join', { roomId: await createRoom(mallory), displayName: 'Mallory' });

  const offer = { description: { type: 'offer', sdp: 'v=0' } };
  await alice.ok('mesh.signal', { to: b.participantId, signal: offer, from: 'spoofed' });
  expect(await bob.waitForEvent('mesh.signal')).toEqual({
    type: 'mesh.signal',
    payload: { from: a.participantId, signal: offer },
  });

  const crossRoom = await mallory.request('mesh.signal', { to: b.participantId, signal: offer });
  expect(crossRoom).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  const huge = { description: { type: 'offer', sdp: 'x'.repeat(40_000) } };
  const tooBig = await alice.request('mesh.signal', { to: b.participantId, signal: huge });
  expect(tooBig).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
});
