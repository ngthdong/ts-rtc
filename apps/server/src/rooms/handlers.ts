import { setTimeout as sleep } from 'node:timers/promises';
import {
  CloseCode,
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

/** A lost Router is replaced on another Worker, or on the dead one's replacement (2 s): 5 s. */
const ROUTER_ATTEMPTS = 20;
const ROUTER_RETRY_MS = 250;

export interface RegistryOptions extends RoomOptions {
  sfuCapacity: number;
  /** A member whose socket dropped keeps its place (and media) this long, to resume. */
  reconnectGraceMs: number;
}

/** Live calls of durable rooms: a Room exists while its call does, under the room's id. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  /** Grace periods running; dropped on shutdown (no leave after the media is gone). */
  private readonly graceTimers = new Set<NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly options: RegistryOptions,
    private readonly log: FastifyBaseLogger,
    /** Who the user is, and the durable room as that user sees it. */
    readonly directory: Directory,
    /** Absent: SFU rooms cannot be joined (tests and Mesh-only setups). */
    readonly media: MediaController | undefined,
  ) {
    media?.onRouterLost((roomId) => {
      const room = this.rooms.get(roomId);
      if (room) void room.executor.run(() => this.resetMedia(room));
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

  /** Socket dropped (not a leave): the membership waits for a resume, then leaves ('timeout'). */
  disconnected(binding: Binding): Promise<void> {
    const { room, participantId, epoch } = binding;
    return room.executor.run(() => {
      if (this.disposed || !room.markReconnecting(participantId, epoch)) return; // stale: a newer binding exists
      const timer = setTimeout(() => {
        this.graceTimers.delete(timer);
        void this.leave(binding, 'timeout');
      }, this.options.reconnectGraceMs);
      timer.unref();
      this.graceTimers.add(timer);
    });
  }

  /** Server shutdown: every socket is closed, nobody will resume. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.graceTimers) clearTimeout(timer);
    this.graceTimers.clear();
  }

  /** The live call, if there is one. */
  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** SFU snapshots list everyone else's Producers, so a late joiner can consume them. */
  withProducers<T extends RoomSnapshot>(room: Room, snapshot: T): T {
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

  /** In the room's executor: the Router to use from now on, its id in every snapshot. */
  async ensureRouter(room: Room, media: MediaController): Promise<void> {
    room.routerRtpCapabilities ??= await media.ensureRouter(room.id);
    room.routerId = media.routerId(room.id);
  }

  /**
   * The room's Worker died, and its media with it. Signaling is unaffected, so the call goes on
   * with a new Router: members are told (sfu.mediaReset) and rebuild their media. A second
   * death within a minute, or no Worker to move to, closes the room (room.closed media_failure).
   */
  private async resetMedia(room: Room): Promise<void> {
    const now = Date.now();
    room.mediaResets = [...room.mediaResets.filter((at) => now - at < 60_000), now];
    room.routerRtpCapabilities = room.routerId = undefined;
    if (room.members.length === 0) return; // the next join creates a Router
    if (room.mediaResets.length > 1 || !this.media) return room.close('media_failure');
    for (let attempt = 1; !room.routerRtpCapabilities; attempt++) {
      try {
        await this.ensureRouter(room, this.media);
      } catch (err) {
        if (attempt === ROUTER_ATTEMPTS) {
          this.log.error({ roomId: room.id, err }, 'media.reset_failed');
          return room.close('media_failure');
        }
        await sleep(ROUTER_RETRY_MS);
      }
    }
    this.log.warn({ roomId: room.id, members: room.members.length }, 'media.reset');
    room.broadcast('sfu.mediaReset', { routerRtpCapabilities: room.routerRtpCapabilities });
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
          await rooms.ensureRouter(room, rooms.media);
        }
        return rooms.withProducers(room, room.join(session, user.displayName, user.id));
      });
    })
    .on('room.resume', ({ resumeToken }, { session }) => {
      const user = requireUser(session);
      const [roomId = '', participantId = '', secret = ''] = resumeToken.split('.');
      const room = rooms.get(roomId);
      if (!room) throw new SignalingError('NOT_FOUND', 'session expired: join the room again');
      return room.executor.run(() => {
        const result = rooms.withProducers(
          room,
          room.resume(session, participantId, secret, user.id),
        );
        return { ...result, transportIds: rooms.media?.transportsOf(participantId) ?? [] };
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

/**
 * A normal close (1000) is the client saying goodbye (tab closed, reload): it leaves now, so
 * nobody sees a "reconnecting" tile for 30 s. Any other close may be a drop: it may resume.
 */
export function leaveOnDisconnect(session: Session, rooms: RoomRegistry, code: number): void {
  if (!session.binding) return;
  if (code === CloseCode.Normal) void rooms.leave(session.binding, 'left');
  else void rooms.disconnected(session.binding);
}

export function requireBinding(session: Session): Binding {
  if (!session.binding) throw new SignalingError('INVALID_STATE', 'not in a room');
  return session.binding;
}

export function requireUser(session: Session): User {
  if (!session.user) throw new SignalingError('UNAUTHENTICATED', 'sign in first');
  return session.user;
}
