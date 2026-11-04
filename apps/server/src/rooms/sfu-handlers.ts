import { SignalingError } from '@ts-rtc/protocol';
import type { MediaController } from '../media/media-controller.js';
import type { RequestRouter } from '../router.js';
import type { Session } from '../session.js';
import { requireBinding, type RoomRegistry } from './handlers.js';
import type { Room } from './room.js';

/**
 * SFU media requests. Each runs in the room's executor, so it cannot interleave with the
 * caller leaving; the media module checks that every id it is given belongs to the caller.
 */
export function registerSfuHandlers(router: RequestRouter, rooms: RoomRegistry): void {
  const inSfuRoom = <T>(
    session: Session,
    task: (media: MediaController, room: Room, participantId: string) => Promise<T>,
  ): Promise<T> => {
    const { room, participantId } = requireBinding(session);
    const media = rooms.media;
    if (room.mode !== 'sfu' || !media) {
      throw new SignalingError('INVALID_STATE', 'not in an SFU room');
    }
    return room.executor.run(() => {
      // Queued behind a leave or a room close? Then there is nobody to give media to.
      if (!room.has(participantId)) throw new SignalingError('INVALID_STATE', 'not in a room');
      return task(media, room, participantId);
    });
  };

  router
    .on('sfu.createTransport', ({ direction }, { session }) =>
      inSfuRoom(session, (media, room, me) => media.createTransport(room.id, me, direction)),
    )
    .on('sfu.connectTransport', ({ transportId, dtlsParameters }, { session }) =>
      inSfuRoom(session, async (media, _room, me) => {
        await media.connectTransport(me, transportId, dtlsParameters);
        return {};
      }),
    )
    .on('sfu.produce', ({ transportId, kind, source, rtpParameters }, { session }) =>
      inSfuRoom(session, async (media, room, me) => {
        const info = await media.produce(me, transportId, kind, source, rtpParameters);
        room.broadcast('sfu.newProducer', info, me); // everyone else consumes it
        return { producerId: info.producerId };
      }),
    )
    .on('sfu.consume', ({ transportId, producerId, rtpCapabilities }, { session }) =>
      inSfuRoom(session, (media, _room, me) =>
        media.consume(me, transportId, producerId, rtpCapabilities),
      ),
    )
    .on('sfu.resumeConsumer', ({ consumerId }, { session }) =>
      inSfuRoom(session, async (media, _room, me) => {
        await media.resumeConsumer(me, consumerId);
        return {};
      }),
    )
    .on('sfu.pauseProducer', ({ producerId, paused }, { session }) =>
      inSfuRoom(session, async (media, _room, me) => {
        await media.pauseProducer(me, producerId, paused);
        return {};
      }),
    );
}
