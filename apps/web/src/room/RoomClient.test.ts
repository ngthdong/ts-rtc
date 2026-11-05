import { SignalingError, type RoomSnapshot, type SignalingEvent } from '@ts-rtc/protocol';
import { expect, test, vi } from 'vitest';
import type { SignalingClient } from '../signaling/SignalingClient.js';
import { RoomClient } from './RoomClient.js';

const unmuted = { audioMuted: false, videoMuted: false, connection: 'connected' as const };
const alice = { participantId: 'a', displayName: 'Alice', ...unmuted };
const bob = { participantId: 'b', displayName: 'Bob', ...unmuted };
const carol = { participantId: 'c', displayName: 'Carol', ...unmuted };
const snapshot = (roomSeq: number, members = [alice]): RoomSnapshot => ({
  roomId: 'r',
  participantId: 'a',
  roomSeq,
  mode: 'mesh',
  members,
});
const joined = (roomSeq: number, participant = bob): SignalingEvent => ({
  type: 'participant.joined',
  payload: { roomSeq, participant },
});

function setup(responses: Record<string, (() => unknown) | undefined>) {
  let emit: (event: SignalingEvent) => void = () => {};
  const signaling = {
    onEvent: (listener: (event: SignalingEvent) => void) => {
      emit = listener;
      return () => {};
    },
    request: vi.fn((type: string) => Promise.resolve(responses[type]?.())),
  };
  const room = new RoomClient(signaling as unknown as SignalingClient);
  return { room, signaling, emit: (event: SignalingEvent) => emit(event) };
}

test('events that race ahead of the join response are replayed on top of the snapshot', async () => {
  const { room, emit } = setup({
    'room.join': () => {
      emit(joined(1, alice)); // already in the snapshot: ignored
      emit(joined(2)); // newer than the snapshot: applied
      return snapshot(1);
    },
  });
  await room.join('r');
  expect(room.view).toMatchObject({ roomSeq: 2, members: [alice, bob] });
});

test('a roomSeq gap triggers room.sync instead of guessing', async () => {
  const { room, emit, signaling } = setup({
    'room.join': () => snapshot(1),
    'room.sync': () => snapshot(3, [alice, carol]),
  });
  await room.join('r');
  emit(joined(3, carol)); // seq 2 was missed
  await vi.waitFor(() => {
    expect(room.view).toMatchObject({ roomSeq: 3, members: [alice, carol] });
  });
  expect(signaling.request).toHaveBeenCalledWith('room.sync', {});
});

test('participant.left removes the member', async () => {
  const { room, emit } = setup({ 'room.join': () => snapshot(2, [alice, bob]) });
  await room.join('r');
  emit({ type: 'participant.left', payload: { roomSeq: 3, participantId: 'b', reason: 'left' } });
  expect(room.view?.members).toEqual([alice]);
});

test('participant.updated changes only that member', async () => {
  const { room, emit } = setup({ 'room.join': () => snapshot(2, [alice, bob]) });
  await room.join('r');
  emit({
    type: 'participant.updated',
    payload: {
      roomSeq: 3,
      participantId: 'b',
      audioMuted: true,
      videoMuted: false,
      connection: 'connected',
    },
  });
  expect(room.view?.members).toEqual([alice, { ...bob, audioMuted: true }]);
});

test('resume: the snapshot replaces the view; a refusal is null and forgets the token', async () => {
  let resumes = 0;
  const { room, signaling } = setup({
    'room.join': () => ({ ...snapshot(1), resumeToken: 'r.a.one' }),
    'room.resume': () => {
      resumes += 1;
      if (resumes === 1) return { ...snapshot(5, [alice, carol]), resumeToken: 'r.a.two' };
      throw new SignalingError('NOT_FOUND', 'session expired: join the room again');
    },
  });
  expect(await room.resume()).toBeNull(); // not in a room: nothing to resume
  await room.join('r');
  expect(room.resumeToken).toBe('r.a.one');
  expect(await room.resume()).toMatchObject({ roomSeq: 5 });
  expect(signaling.request).toHaveBeenLastCalledWith('room.resume', { resumeToken: 'r.a.one' });
  expect(room.view).toEqual(snapshot(5, [alice, carol])); // no token in the view
  expect(room.resumeToken).toBe('r.a.two'); // rotated
  expect(await room.resume()).toBeNull();
  expect(room.resumeToken).toBeNull();
  expect(room.view).not.toBeNull(); // the caller decides: rejoin, or abandon
});

test('the resume token is used once: a resume lost in transit is not sent again', async () => {
  const { room, signaling } = setup({
    'room.join': () => ({ ...snapshot(1), resumeToken: 'r.a.one' }),
    'room.resume': () => {
      throw new SignalingError('UNAVAILABLE', 'connection closed');
    },
  });
  await room.join('r');
  await expect(room.resume()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(await room.resume()).toBeNull(); // next reconnect: nothing to resume with, so rejoin
  expect(signaling.request).toHaveBeenCalledTimes(2); // join + one resume
});

test('expire (Mesh, grace over): the call ends and says why', async () => {
  const { room } = setup({ 'room.join': () => ({ ...snapshot(1), resumeToken: 'r.a.one' }) });
  await room.join('r');
  room.expire();
  expect(room.view).toBeNull();
  expect(room.closedReason).toBe('session expired');
  expect(room.resumeToken).toBeNull();
});
