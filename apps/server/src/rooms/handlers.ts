import { SignalingError } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { RequestRouter } from '../router.js';
import type { Session } from '../session.js';
import { Room, type Binding, type RoomOptions } from './room.js';

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly options: RoomOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  create(): Room {
    const room = new Room(this.options, this.log, (closed) => this.rooms.delete(closed.id));
    this.rooms.set(room.id, room);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }
}

export function registerRoomHandlers(router: RequestRouter, rooms: RoomRegistry): void {
  router
    .on('room.create', () => ({ roomId: rooms.create().id }))
    .on('room.join', ({ roomId, displayName }, { session }) => {
      const room = rooms.get(roomId);
      if (!room) throw new SignalingError('NOT_FOUND', 'room not found');
      return room.executor.run(() => room.join(session, displayName));
    })
    .on('room.leave', async (_payload, { session }) => {
      const { room, participantId, epoch } = requireBinding(session);
      await room.executor.run(() => room.remove(participantId, epoch, 'left'));
      return {};
    })
    .on('room.sync', (_payload, { session }) => {
      const { room, participantId } = requireBinding(session);
      return room.executor.run(() => room.snapshot(participantId));
    });
}

/** Socket gone: leave the room, unless a newer binding has replaced this one (epoch check). */
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
