import { SignalingError, type RoomMode } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { MediaController } from '../media/media-controller.js';
import type { RequestRouter } from '../router.js';
import type { Session } from '../session.js';
import { Room, type Binding, type RoomOptions } from './room.js';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly options: RoomOptions,
    private readonly log: FastifyBaseLogger,
    /** Absent: SFU rooms cannot be joined (tests and Mesh-only setups). */
    readonly media: MediaController | undefined,
  ) {
    media?.onRouterLost((roomId) => {
      const room = this.rooms.get(roomId);
      if (room) void room.executor.run(() => room.close('media_failure'));
    });
  }

  create(mode: RoomMode): Room {
    const onClosed = (closed: Room) => {
      this.rooms.delete(closed.id);
      if (closed.mode === 'sfu') this.media?.closeRouter(closed.id);
    };
    const room = new Room(this.options, this.log, onClosed, mode);
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
      const { room, participantId, epoch } = requireBinding(session);
      await room.executor.run(() => room.remove(participantId, epoch, 'left'));
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

export function leaveOnDisconnect(session: Session): void {
  const binding = session.binding;
  if (!binding) return;
  const { room, participantId, epoch } = binding;
  void room.executor.run(() => room.remove(participantId, epoch, 'disconnected'));
}

function requireBinding(session: Session): Binding {
  if (!session.binding) throw new SignalingError('INVALID_STATE', 'not in a room');
  return session.binding;
}
