import { randomUUID } from 'node:crypto';
import {
  MeshSignal,
  SignalingError,
  type EventPayload,
  type EventType,
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
}

/** A session's membership. `epoch` lets a stale disconnect be told apart from a current one. */
export interface Binding {
  room: Room;
  participantId: string;
  epoch: number;
}

interface Participant extends MuteState {
  id: string;
  displayName: string;
  epoch: number;
  peer: Peer;
}

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
  readonly id = randomUUID();
  readonly executor = new SerialExecutor();
  state: RoomState = 'created';
  roomSeq = 0;
  /** SFU rooms: set once the room's Router exists (by the join handler, in the executor). */
  routerRtpCapabilities: RtpCapabilities | undefined;
  activeSpeaker: string | undefined;
  private readonly participants = new Map<string, Participant>();
  private readonly log: FastifyBaseLogger;
  private timer: NodeJS.Timeout | undefined;

  constructor(
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

  join(peer: Peer, displayName: string): RoomSnapshot {
    if (peer.binding?.room === this) return this.snapshot(peer.binding.participantId);
    if (peer.binding) throw new SignalingError('CONFLICT', 'already in another room');
    if (this.state === 'closed') throw new SignalingError('NOT_FOUND', 'room not found');
    if (this.participants.size >= this.options.capacity) {
      throw new SignalingError('CAPACITY_EXCEEDED', 'room is full');
    }
    const participant: Participant = {
      id: randomUUID(),
      displayName,
      epoch: 1,
      peer,
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
    return this.snapshot(participant.id);
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
    const roomSeq = ++this.roomSeq;
    this.broadcast('participant.updated', { roomSeq, participantId, ...state });
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
  close(reason: 'media_failure'): void {
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
    target.peer.emit('mesh.signal', { from, signal });
  }

  snapshot(participantId: string): RoomSnapshot {
    if (!this.participants.has(participantId)) {
      throw new SignalingError('INVALID_STATE', 'not a member of this room');
    }
    const { id: roomId, roomSeq, mode, members, routerRtpCapabilities, activeSpeaker } = this;
    return {
      roomId,
      participantId,
      roomSeq,
      mode,
      members,
      ...(routerRtpCapabilities && { routerRtpCapabilities }),
      ...(activeSpeaker && this.participants.has(activeSpeaker) && { activeSpeaker }),
    };
  }

  broadcast<T extends EventType>(type: T, payload: EventPayload<T>, except?: string): void {
    for (const participant of this.participants.values()) {
      if (participant.id !== except) participant.peer.emit(type, payload);
    }
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

function toMember({ id, displayName, audioMuted, videoMuted }: Participant): Member {
  return { participantId: id, displayName, audioMuted, videoMuted };
}
