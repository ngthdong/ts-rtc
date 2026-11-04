import { expect, test } from 'vitest';
import { can, type MediaAction, type RoomAction } from '../src/auth/policy.js';

const me = { userId: 'u-me' };
const roles = {
  owner: { ownerId: 'u-me', isMember: false },
  member: { ownerId: 'u-other', isMember: true },
  stranger: { ownerId: 'u-other', isMember: false },
} as const;

/**
 * Written out by hand, not derived from the code: Y = allowed. Columns: owner, member,
 * stranger; first in a public room, then in a private one.
 */
const ROOM_MATRIX: Record<RoomAction, string> = {
  'room.join': 'YYY YYN',
  'room.delete': 'YNN YNN',
  'room.addMember': 'YNN YNN',
  'room.removeMember': 'YNN YNN',
};

test.each(Object.entries(ROOM_MATRIX))('%s: %s', (action, expected) => {
  const actual = (['public', 'private'] as const)
    .map((visibility) =>
      Object.values(roles)
        .map((role) => (can(me, action as RoomAction, { ...role, visibility }).allow ? 'Y' : 'N'))
        .join(''),
    )
    .join(' ');
  expect(actual).toBe(expected);
});

/** Columns: not joined; joined, someone else's target; joined, own target. */
const MEDIA_MATRIX: Record<MediaAction, string> = {
  'participant.update': 'NYY',
  'mesh.signal': 'NYY',
  'sfu.createTransport': 'NYY',
  'sfu.connectTransport': 'NYY', // transport ownership: the media module (NOT_FOUND)
  'sfu.produce': 'NYY',
  'sfu.consume': 'NYY', // anyone's Producer in the same room
  'sfu.resumeConsumer': 'NYY',
  'sfu.closeProducer': 'NNY',
  'sfu.pauseProducer': 'NNY',
};

test.each(Object.entries(MEDIA_MATRIX))('%s: %s', (action, expected) => {
  const cases = [
    { joined: false, ownsTarget: true },
    { joined: true, ownsTarget: false },
    { joined: true, ownsTarget: true },
  ];
  const actual = cases.map((facts) => (can(me, action as MediaAction, facts).allow ? 'Y' : 'N'));
  expect(actual.join('')).toBe(expected);
});

test('not being in the room is a state error, not a permission error', () => {
  expect(can(me, 'sfu.produce', { joined: false })).toMatchObject({ code: 'INVALID_STATE' });
  expect(can(me, 'sfu.closeProducer', { joined: true })).toMatchObject({ code: 'FORBIDDEN' });
});
