import { SignalingError, type LeaveReason, type RoomMode } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { MediaController } from '../media/media-controller.js';
import type { RequestRouter } from '../router.js';
import type { Session } from '../session.js';
import { Room, type Binding, type RoomOptions } from './room.js';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly options: RoomOptions & { sfuCapacity: number },
    private readonly log: FastifyBaseLogger,
    /** Absent: SFU rooms cannot be joined (tests and Mesh-only setups). */
    readonly media: MediaController | undefined,
  ) {
    media?.onRouterLost((roomId) => {
      const room = this.rooms.get(roomId);
      if (room) void room.executor.run(() => room.close('media_failure'));
    });
    media?.onTransportClosed((roomId, participantId, transportId, reason) => {
      const room = this.rooms.get(roomId);
      void room?.executor.run(() => {
        room.emitTo(participantId, 'sfu.transportClosed', { transportId, reason });
      });
    });
  }

  /** The one leave path (request or disconnect): epoch-checked, then the media goes too. */
  leave({ room, participantId, epoch }: Binding, reason: LeaveReason): Promise<void> {
    return room.executor.run(() => {
      if (room.remove(participantId, epoch, reason)) this.media?.closeParticipant(participantId);
    });
  }

  create(mode: RoomMode): Room {
    const onClosed = (closed: Room) => {
      this.rooms.delete(closed.id);
      if (closed.mode === 'sfu') this.media?.closeRouter(closed.id);
    };
    const capacity = mode === 'sfu' ? this.options.sfuCapacity : this.options.capacity;
    const room = new Room({ ...this.options, capacity }, this.log, onClosed, mode);
    this.rooms.set(room.id, room);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }
}

export function registerRoomHandlers(router: RequestRouter, rooms: RoomRegistry): void {
  router
    .on('room.create', ({ mode = 'mesh' }) => ({ roomId: rooms.create(mode).id }))
    .on('room.join', ({ roomId, displayName }, { session }) => {
      const room = rooms.get(roomId);
      if (!room) throw new SignalingError('NOT_FOUND', 'room not found');
      return room.executor.run(async () => {
        if (room.mode === 'sfu' && room.state !== 'closed' && !session.binding) {
          if (!rooms.media) throw new SignalingError('UNAVAILABLE', 'SFU is not enabled');
          // Inside the executor: two first joins cannot create two Routers, and the room
          // cannot close while we wait (closing is an executor task too).
          room.routerRtpCapabilities ??= await rooms.media.ensureRouter(room.id);
        }
        return room.join(session, displayName);
      });
    })
    .on('room.leave', async (_payload, { session }) => {
      await rooms.leave(requireBinding(session), 'left');
      return {};
    })
    .on('room.sync', (_payload, { session }) => {
      const { room, participantId } = requireBinding(session);
      return room.executor.run(() => room.snapshot(participantId));
    })
    .on('participant.update', async (state, { session }) => {
      const { room, participantId } = requireBinding(session);
      await room.executor.run(() => {
        room.update(participantId, state);
      });
      return {};
    })
    .on('mesh.signal', async ({ to, signal }, { session, log }) => {
      const { room, participantId } = requireBinding(session);
      const kind = 'description' in signal ? signal.description.type : 'candidate';
      log.debug({ participantId, to, kind }, 'mesh.signal'); // never the SDP itself
      await room.executor.run(() => {
        room.relay(participantId, to, signal);
      });
      return {};
    });
}

export function leaveOnDisconnect(session: Session, rooms: RoomRegistry): void {
  if (session.binding) void rooms.leave(session.binding, 'disconnected');
}

export function requireBinding(session: Session): Binding {
  if (!session.binding) throw new SignalingError('INVALID_STATE', 'not in a room');
  return session.binding;
}
