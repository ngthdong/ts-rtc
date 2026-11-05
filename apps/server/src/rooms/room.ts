import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CloseCode,
  MeshSignal,
  SignalingError,
  type EventPayload,
  type ConnectionState,
  type EventType,
  type JoinResult,
  type LeaveReason,
  type Member,
  type MuteState,
  type RoomMode,
  type RoomSnapshot,
} from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { RtpCapabilities } from '../media/media-controller.js';
import { SerialExecutor } from './executor.js';

/** What a room needs from a connection: where to send events, and its current binding. */
export interface Peer {
  binding: Binding | undefined;
  emit<T extends EventType>(type: T, payload: EventPayload<T>): void;
  /** A resume from another connection replaces this one. */
  close(code: number, reason: string): void;
}

/** A session's membership. `epoch` lets a stale disconnect be told apart from a current one. */
export interface Binding {
  room: Room;
  participantId: string;
  epoch: number;
}

interface Participant extends MuteState {
  id: string;
  /** The account: only the same user may resume this participant. */
  userId: string;
  displayName: string;
  /** +1 on every resume: a close or a grace timer from an earlier connection is stale. */
  epoch: number;
  peer: Peer;
  connection: ConnectionState;
  /** SHA-256 of the current resume secret; the secret itself is never stored. */
  resumeHash: Buffer;
  /**
   * Mesh signals that arrived while reconnecting, delivered on resume. Room state is resent as
   * a snapshot, but a lost offer cannot be recomputed: the call to that peer would never start.
   */
  heldSignals: { from: string; signal: MeshSignal }[];
}

/** Enough for an offer and its candidates from a few peers; the rest is dropped. */
const MAX_HELD_SIGNALS = 100;

export interface RoomOptions {
  capacity: number;
  createdTtlMs: number; // A room nobody joined is removed after this long.
  emptyGraceMs: number; // A room whose last member left is kept this long, then removed.
}

export type RoomState = 'created' | 'active' | 'empty' | 'closed';

const TRANSITIONS: Record<RoomState, readonly RoomState[]> = {
  created: ['active', 'closed'],
  active: ['empty', 'closed'], // closed while active: only by close(), e.g. media failure
  empty: ['active', 'closed'],
  closed: [],
};

/**
 * In-memory room. Every method must run inside `executor.run(...)`; methods are synchronous
 * so a task cannot be interleaved with another one halfway through.
 */
export class Room {
  readonly executor = new SerialExecutor();
  state: RoomState = 'created';
  roomSeq = 0;
  /** SFU rooms: set once the room's Router exists (by the join handler, in the executor). */
  routerRtpCapabilities: RtpCapabilities | undefined;
  routerId: string | undefined;
  /** When the room's media was reset (its Worker died), within the last minute. */
  mediaResets: number[] = [];
  activeSpeaker: string | undefined;
  private readonly participants = new Map<string, Participant>();
  private readonly log: FastifyBaseLogger;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    /** The durable room's id (POST /api/rooms): the live call lives under the same id. */
    readonly id: string,
    private readonly options: RoomOptions,
    log: FastifyBaseLogger,
    private readonly onClosed: (room: Room) => void,
    readonly mode: RoomMode = 'mesh',
  ) {
    this.log = log.child({ roomId: this.id });
    this.closeAfter(options.createdTtlMs);
  }

  get members(): Member[] {
    return [...this.participants.values()].map(toMember);
  }

  join(peer: Peer, displayName: string, userId: string): JoinResult {
    if (peer.binding?.room === this) return this.withToken(peer.binding.participantId);
    if (peer.binding) throw new SignalingError('CONFLICT', 'already in another room');
    if (this.state === 'closed') throw new SignalingError('NOT_FOUND', 'room not found');
    if (this.participants.size >= this.options.capacity) {
      throw new SignalingError('CAPACITY_EXCEEDED', 'room is full');
    }
    const participant: Participant = {
      id: randomUUID(),
      userId,
      displayName,
      epoch: 1,
      peer,
      connection: 'connected',
      resumeHash: Buffer.alloc(0),
      heldSignals: [],
      audioMuted: false,
      videoMuted: false,
    };
    this.participants.set(participant.id, participant);
    peer.binding = { room: this, participantId: participant.id, epoch: participant.epoch };
    if (this.state !== 'active') this.transition('active');
    const roomSeq = ++this.roomSeq;
    this.log.info({ participantId: participant.id, roomSeq }, 'participant.joined');
    // The joiner learns about itself from the snapshot; everyone else from the event.
    this.broadcast(
      'participant.joined',
      { roomSeq, participant: toMember(participant) },
      participant.id,
    );
    return this.withToken(participant.id);
  }

  /**
   * The member's socket closed: it stays (and keeps its media) while it may resume. False when
   * `epoch` is stale (already resumed elsewhere) or it is already reconnecting.
   */
  markReconnecting(participantId: string, epoch: number): boolean {
    const participant = this.participants.get(participantId);
    if (participant?.epoch !== epoch || participant.connection === 'reconnecting') return false;
    participant.connection = 'reconnecting';
    if (participant.peer.binding?.participantId === participantId)
      participant.peer.binding = undefined;
    this.broadcastState(participant); // participant.updated {connection:'reconnecting'}
    return true;
  }

  /**
   * Binds `peer` to an existing participant: same user, current secret. A connection still
   * bound to it (half-open, or another tab) is told and closed with 4409.
   */
  resume(peer: Peer, participantId: string, secret: string, userId: string): JoinResult {
    const participant = this.participants.get(participantId);
    const given = createHash('sha256').update(secret).digest();
    if (
      !participant ||
      participant.userId !== userId ||
      !timingSafeEqual(given, participant.resumeHash)
    ) {
      throw new SignalingError('NOT_FOUND', 'session expired: join the room again');
    }
    if (peer.binding && peer.binding.participantId !== participantId) {
      throw new SignalingError('CONFLICT', 'already in a room');
    }
    const old = participant.peer;
    if (old !== peer && old.binding?.participantId === participantId) {
      old.binding = undefined;
      old.emit('session.replaced', {});
      old.close(CloseCode.Replaced, 'resumed by another connection'); // 4409
    }
    participant.epoch += 1;
    participant.peer = peer;
    peer.binding = { room: this, participantId, epoch: participant.epoch };
    this.log.info({ participantId, epoch: participant.epoch }, 'session.bound');
    if (participant.connection === 'reconnecting') {
      participant.connection = 'connected';
      this.broadcastState(participant);
    }
    for (const held of participant.heldSignals.splice(0)) peer.emit('mesh.signal', held);
    return this.withToken(participantId); // `<room>.<participant>.<256-bit secret>`, hash stored
  }

  remove(participantId: string, epoch: number, reason: LeaveReason): boolean {
    const participant = this.participants.get(participantId);
    if (!participant || participant.epoch !== epoch) return false;
    this.participants.delete(participantId);
    if (participant.peer.binding?.participantId === participantId) {
      participant.peer.binding = undefined;
    }
    const roomSeq = ++this.roomSeq;
    this.log.info({ participantId, roomSeq, reason }, 'participant.left');
    this.broadcast('participant.left', { roomSeq, participantId, reason });
    if (this.participants.size === 0) this.transition('empty');
    return true;
  }

  /** Mute state is room state: ordered by roomSeq, sent to everyone (the sender included). */
  update(participantId: string, state: MuteState): void {
    const participant = this.participants.get(participantId);
    if (!participant) throw new SignalingError('INVALID_STATE', 'not a member of this room');
    if (
      participant.audioMuted === state.audioMuted &&
      participant.videoMuted === state.videoMuted
    ) {
      return; // nothing changed: no event
    }
    participant.audioMuted = state.audioMuted;
    participant.videoMuted = state.videoMuted;
    this.broadcastState(participant);
  }

  /** The speaker highlight is room state: ordered by roomSeq like membership. */
  setActiveSpeaker(participantId: string): void {
    if (!this.participants.has(participantId) || participantId === this.activeSpeaker) return;
    this.activeSpeaker = participantId;
    this.broadcast('sfu.activeSpeaker', { roomSeq: ++this.roomSeq, participantId });
  }

  has(participantId: string): boolean {
    return this.participants.has(participantId);
  }

  /** An event for one member only (e.g. about its own media), if it is still here. */
  emitTo<T extends EventType>(participantId: string, type: T, payload: EventPayload<T>): void {
    this.participants.get(participantId)?.peer.emit(type, payload);
  }

  /** Ends the room for everyone at once; members are unbound and told why. Idempotent. */
  close(reason: EventPayload<'room.closed'>['reason']): void {
    if (this.state === 'closed') return;
    for (const participant of this.participants.values()) {
      if (participant.peer.binding?.room === this) participant.peer.binding = undefined;
      participant.peer.emit('room.closed', { reason });
    }
    this.log.warn({ reason, members: this.participants.size }, 'room.closed');
    this.participants.clear();
    this.transition('closed');
  }

  // Forwards a WebRTC signal to one other member. The server never looks inside it.
  relay(from: string, to: string, signal: MeshSignal): void {
    if (!this.participants.has(from)) {
      throw new SignalingError('INVALID_STATE', 'not a member of this room');
    }
    const target = this.participants.get(to);
    if (!target || to === from) {
      throw new SignalingError('NOT_FOUND', 'no such participant in this room');
    }
    if (target.connection === 'connected') target.peer.emit('mesh.signal', { from, signal });
    else if (target.heldSignals.length < MAX_HELD_SIGNALS)
      target.heldSignals.push({ from, signal });
  }

  snapshot(participantId: string): RoomSnapshot {
    if (!this.participants.has(participantId)) {
      throw new SignalingError('INVALID_STATE', 'not a member of this room');
    }
    const { id: roomId, roomSeq, mode, members, routerRtpCapabilities, routerId } = this;
    const { activeSpeaker } = this;
    return {
      roomId,
      participantId,
      roomSeq,
      mode,
      members,
      ...(routerRtpCapabilities && { routerRtpCapabilities }),
      ...(routerId && { routerId }),
      ...(activeSpeaker && this.participants.has(activeSpeaker) && { activeSpeaker }),
    };
  }

  broadcast<T extends EventType>(type: T, payload: EventPayload<T>, except?: string): void {
    for (const participant of this.participants.values()) {
      if (participant.id !== except) participant.peer.emit(type, payload);
    }
  }

  /** Mute and connection state are room state: one event, ordered by roomSeq, to everyone. */
  private broadcastState(participant: Participant): void {
    const { id: participantId, audioMuted, videoMuted, connection } = participant;
    const roomSeq = ++this.roomSeq;
    this.broadcast('participant.updated', {
      roomSeq,
      participantId,
      audioMuted,
      videoMuted,
      connection,
    });
  }

  /** The snapshot plus a fresh resume token; only the token's hash is kept. */
  private withToken(participantId: string): JoinResult {
    const participant = this.participants.get(participantId);
    if (!participant) throw new SignalingError('INVALID_STATE', 'not a member of this room');
    const secret = randomBytes(32).toString('base64url');
    participant.resumeHash = createHash('sha256').update(secret).digest();
    return {
      ...this.snapshot(participantId),
      resumeToken: `${this.id}.${participantId}.${secret}`,
    };
  }

  private transition(to: RoomState): void {
    if (!TRANSITIONS[this.state].includes(to)) {
      this.log.error({ from: this.state, to }, 'room.illegal_transition');
      throw new SignalingError('INVALID_STATE', `room cannot go from ${this.state} to ${to}`);
    }
    this.log.info({ from: this.state, to }, 'room.transition');
    this.state = to;
    clearTimeout(this.timer);
    if (to === 'empty') this.closeAfter(this.options.emptyGraceMs);
    if (to === 'closed') this.onClosed(this);
  }

  private closeAfter(ms: number): void {
    this.timer = setTimeout(() => {
      void this.executor.run(() => {
        if (this.state === 'created' || this.state === 'empty') this.transition('closed');
      });
    }, ms);
    this.timer.unref();
  }
}

function toMember({ id, displayName, connection, audioMuted, videoMuted }: Participant): Member {
  return { participantId: id, displayName, connection, audioMuted, videoMuted };
}
