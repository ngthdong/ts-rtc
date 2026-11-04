import { SignalingError } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Visibility } from '../db/rooms.js';

export type RoomAction = 'room.join' | 'room.delete' | 'room.addMember' | 'room.removeMember';
export type MediaAction =
  | 'participant.update'
  | 'mesh.signal'
  | 'sfu.createTransport'
  | 'sfu.connectTransport'
  | 'sfu.produce'
  | 'sfu.consume'
  | 'sfu.resumeConsumer'
  | 'sfu.closeProducer'
  | 'sfu.pauseProducer';
export type Action = RoomAction | MediaAction;

/** What a room action is decided on: the durable room and the actor's membership. */
export interface RoomFacts {
  ownerId: string;
  visibility: Visibility;
  isMember: boolean;
}
/** What a media action is decided on: live state, read inside the room executor. */
export interface MediaFacts {
  /** The actor's participant is joined in the room this operation targets. */
  joined: boolean;
  /** For operations on one Producer: it belongs to the actor's participant. */
  ownsTarget?: boolean;
}

export type Decision =
  { allow: true } | { allow: false; code: 'FORBIDDEN' | 'INVALID_STATE'; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string, code: 'FORBIDDEN' | 'INVALID_STATE' = 'FORBIDDEN'): Decision => ({
  allow: false,
  code,
  reason,
});
/** Operations on someone's Producer: only its owner. Transport and Consumer ids are checked by
 * the media module (someone else's id is NOT_FOUND there). */
const OWNER_SCOPED: ReadonlySet<Action> = new Set(['sfu.closeProducer', 'sfu.pauseProducer']);

/** The one authorization policy. Pure: every input is in the arguments. */
export function can(
  actor: { userId: string },
  action: Action,
  facts: RoomFacts | MediaFacts,
): Decision {
  if ('visibility' in facts) {
    const owner = facts.ownerId === actor.userId;
    if (action !== 'room.join') return owner ? ALLOW : deny('only the owner may do this');
    if (facts.visibility === 'public' || owner || facts.isMember) return ALLOW;
    return deny('private room: ask the owner to add you');
  }
  if (!facts.joined) return deny('not in a room', 'INVALID_STATE');
  if (OWNER_SCOPED.has(action) && !facts.ownsTarget) return deny('not your producer');
  return ALLOW;
}

/** can(), enforced: logs `auth.denied` (never token contents) and throws the error to return. */
export function authorize(
  log: FastifyBaseLogger,
  actor: { userId: string },
  action: Action,
  facts: RoomFacts | MediaFacts,
): void {
  const decision = can(actor, action, facts);
  if (decision.allow) return;
  log.info({ action, userId: actor.userId, reason: decision.reason }, 'auth.denied');
  throw new SignalingError(decision.code, decision.reason);
}
