import { SignalingError } from '@ts-rtc/protocol';
import type { MediaController } from '../media/media-controller.js';
import type { RequestRouter } from '../router.js';
import type { Session } from '../session.js';
import { requireBinding, type RoomRegistry } from './handlers.js';

/**
 * SFU media requests. Each runs in the room's executor, so it cannot interleave with the
 * caller leaving; the media module checks that every id it is given belongs to the caller.
 */
export function registerSfuHandlers(router: RequestRouter, rooms: RoomRegistry): void {
  const inSfuRoom = <T>(
    session: Session,
    task: (media: MediaController, roomId: string, participantId: string) => Promise<T>,
  ): Promise<T> => {
    const { room, participantId } = requireBinding(session);
    const media = rooms.media;
    if (room.mode !== 'sfu' || !media) {
      throw new SignalingError('INVALID_STATE', 'not in an SFU room');
    }
    return room.executor.run(() => {
      // Queued behind a leave or a room close? Then there is nobody to give media to.
      if (!room.has(participantId)) throw new SignalingError('INVALID_STATE', 'not in a room');
      return task(media, room.id, participantId);
    });
  };

  router
    .on('sfu.createTransport', ({ direction }, { session }) =>
      inSfuRoom(session, (media, roomId, me) => media.createTransport(roomId, me, direction)),
    )
    .on('sfu.connectTransport', ({ transportId, dtlsParameters }, { session }) =>
      inSfuRoom(session, async (media, _roomId, me) => {
        await media.connectTransport(me, transportId, dtlsParameters);
        return {};
      }),
    )
    .on('sfu.produce', ({ transportId, kind, rtpParameters }, { session }) =>
      inSfuRoom(session, async (media, _roomId, me) => ({
        producerId: await media.produce(me, transportId, kind, rtpParameters),
      })),
    )
    .on('sfu.consume', ({ transportId, producerId, rtpCapabilities }, { session }) =>
      inSfuRoom(session, (media, _roomId, me) =>
        media.consume(me, transportId, producerId, rtpCapabilities),
      ),
    );
}
