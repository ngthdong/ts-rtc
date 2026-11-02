import type { RoomSnapshot, SignalingEvent } from '@ts-rtc/protocol';
import { expect, test, vi } from 'vitest';
import type { SignalingClient } from '../signaling/SignalingClient.js';
import { RoomClient } from './RoomClient.js';

const unmuted = { audioMuted: false, videoMuted: false };
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
  await room.join('r', 'Alice');
  expect(room.view).toMatchObject({ roomSeq: 2, members: [alice, bob] });
});

test('a roomSeq gap triggers room.sync instead of guessing', async () => {
  const { room, emit, signaling } = setup({
    'room.join': () => snapshot(1),
    'room.sync': () => snapshot(3, [alice, carol]),
  });
  await room.join('r', 'Alice');
  emit(joined(3, carol)); // seq 2 was missed
  await vi.waitFor(() => {
    expect(room.view).toMatchObject({ roomSeq: 3, members: [alice, carol] });
  });
  expect(signaling.request).toHaveBeenCalledWith('room.sync', {});
});

test('participant.left removes the member', async () => {
  const { room, emit } = setup({ 'room.join': () => snapshot(2, [alice, bob]) });
  await room.join('r', 'Alice');
  emit({ type: 'participant.left', payload: { roomSeq: 3, participantId: 'b', reason: 'left' } });
  expect(room.view?.members).toEqual([alice]);
});

test('participant.updated changes only that member', async () => {
  const { room, emit } = setup({ 'room.join': () => snapshot(2, [alice, bob]) });
  await room.join('r', 'Alice');
  emit({
    type: 'participant.updated',
    payload: { roomSeq: 3, participantId: 'b', audioMuted: true, videoMuted: false },
  });
  expect(room.view?.members).toEqual([alice, { ...bob, audioMuted: true }]);
});
