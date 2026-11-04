import {
  SignalingError,
  type EventPayload,
  type LeaveReason,
  type RoomSnapshot,
} from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Directory } from '../auth/directory.js';
import { authorize, type MediaAction } from '../auth/policy.js';
import type { RoomRecord } from '../db/rooms.js';
import type { User } from '../db/users.js';
import type { MediaController } from '../media/media-controller.js';
import type { RequestContext, RequestRouter } from '../router.js';
import type { Session } from '../session.js';
import { Room, type Binding, type RoomOptions } from './room.js';

/** Live calls of durable rooms: a Room exists while its call does, under the room's id. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly options: RoomOptions & { sfuCapacity: number },
    private readonly log: FastifyBaseLogger,
    /** Who the user is, and the durable room as that user sees it. */
    readonly directory: Directory,
    /** Absent: SFU rooms cannot be joined (tests and Mesh-only setups). */
    readonly media: MediaController | undefined,
  ) {
    media?.onRouterLost((roomId) => {
      const room = this.rooms.get(roomId);
      if (room) void room.executor.run(() => room.close('media_failure'));
    });
    media?.onActiveSpeaker((roomId, participantId) => {
      const room = this.rooms.get(roomId);
      void room?.executor.run(() => {
        room.setActiveSpeaker(participantId); // a speaker who left meanwhile: dropped there
      });
    });
    media?.onEvent((roomId, participantId, { type, payload }) => {
      const room = this.rooms.get(roomId);
      void room?.executor.run(() => {
        room.emitTo(participantId, type, payload);
      });
    });
  }

  /** The one leave path (request or disconnect): epoch-checked, then the media goes too. */
  leave({ room, participantId, epoch }: Binding, reason: LeaveReason): Promise<void> {
    return room.executor.run(() => {
      if (room.remove(participantId, epoch, reason)) this.media?.closeParticipant(participantId);
    });
  }

  /** SFU snapshots list everyone else's Producers, so a late joiner can consume them. */
  withProducers(room: Room, snapshot: RoomSnapshot): RoomSnapshot {
    if (room.mode !== 'sfu' || !this.media) return snapshot;
    const others = this.media
      .producers(room.id)
      .filter((p) => p.participantId !== snapshot.participantId);
    return { ...snapshot, producers: others };
  }

  /** The live call of a durable room: started by its first join, gone when it closes. */
  open(record: RoomRecord): Room {
    const existing = this.rooms.get(record.id);
    if (existing) return existing;
    const onClosed = (closed: Room) => {
      this.rooms.delete(closed.id);
      if (closed.mode === 'sfu') this.media?.closeRouter(closed.id);
    };
    const modeLimit = record.mode === 'sfu' ? this.options.sfuCapacity : this.options.capacity;
    const capacity = Math.min(modeLimit, record.maxParticipants);
    const room = new Room(
      record.id,
      { ...this.options, capacity },
      this.log,
      onClosed,
      record.mode,
    );
    this.rooms.set(room.id, room);
    return room;
  }

  /** Ends a live call for everyone (e.g. its durable room was deleted). None: nothing to do. */
  async close(roomId: string, reason: EventPayload<'room.closed'>['reason']): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room) await room.executor.run(() => room.close(reason));
  }
}

export function registerRoomHandlers(router: RequestRouter, rooms: RoomRegistry): void {
  router
    .on('room.join', async ({ roomId }, { session, log }) => {
      const user = requireUser(session);
      const record = await rooms.directory.room(roomId, user.id); // fresh, never cached
      if (!record) throw new SignalingError('NOT_FOUND', 'room not found');
      authorize(log, { userId: user.id }, 'room.join', record);
      const room = rooms.open(record);
      return room.executor.run(async () => {
        if (room.mode === 'sfu' && room.state !== 'closed' && !session.binding) {
          if (!rooms.media) throw new SignalingError('UNAVAILABLE', 'SFU is not enabled');
          // Inside the executor: two first joins cannot create two Routers, and the room
          // cannot close while we wait (closing is an executor task too).
          room.routerRtpCapabilities ??= await rooms.media.ensureRouter(room.id);
        }
        return rooms.withProducers(room, room.join(session, user.displayName));
      });
    })
    .on('room.leave', async (_payload, { session }) => {
      await rooms.leave(requireBinding(session), 'left');
      return {};
    })
    .on('room.sync', (_payload, { session }) => {
      const { room, participantId } = requireBinding(session);
      return room.executor.run(() => rooms.withProducers(room, room.snapshot(participantId)));
    })
    .on('participant.update', async (state, ctx) => {
      await inRoom(ctx, 'participant.update', (room, me) => {
        room.update(me, state);
      });
      return {};
    })
    .on('mesh.signal', async ({ to, signal }, ctx) => {
      const kind = 'description' in signal ? signal.description.type : 'candidate';
      await inRoom(ctx, 'mesh.signal', (room, me) => {
        ctx.log.debug({ participantId: me, to, kind }, 'mesh.signal'); // never the SDP itself
        room.relay(me, to, signal);
      });
      return {};
    });
}

/**
 * Runs `task` in the caller's room executor once the policy allows `action` there: checked
 * inside the executor, so a leave or close queued before it is seen.
 */
export function inRoom<T>(
  { session, log }: RequestContext,
  action: MediaAction,
  task: (room: Room, participantId: string) => T | Promise<T>,
  targetOwner?: (room: Room) => string | undefined,
): Promise<T> {
  const { room, participantId } = requireBinding(session);
  const userId = requireUser(session).id;
  return room.executor.run(() => {
    const joined = room.has(participantId);
    const owner = joined && targetOwner ? targetOwner(room) : undefined;
    if (joined && targetOwner && owner === undefined) {
      throw new SignalingError('NOT_FOUND', 'no such producer in this room');
    }
    authorize(log, { userId }, action, { joined, ownsTarget: owner === participantId });
    return task(room, participantId);
  });
}

export function leaveOnDisconnect(session: Session, rooms: RoomRegistry): void {
  if (session.binding) void rooms.leave(session.binding, 'disconnected');
}

export function requireBinding(session: Session): Binding {
  if (!session.binding) throw new SignalingError('INVALID_STATE', 'not in a room');
  return session.binding;
}

export function requireUser(session: Session): User {
  if (!session.user) throw new SignalingError('UNAUTHENTICATED', 'sign in first');
  return session.user;
}
