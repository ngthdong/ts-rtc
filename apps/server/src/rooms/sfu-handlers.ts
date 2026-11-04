import { SignalingError } from '@ts-rtc/protocol';
import type { MediaAction } from '../auth/policy.js';
import type { MediaController } from '../media/media-controller.js';
import type { RequestContext, RequestRouter } from '../router.js';
import { inRoom, type RoomRegistry } from './handlers.js';
import type { Room } from './room.js';

/** One SFU operation: who asks (`ctx`), what (`action`), and on whose Producer, if any. */
interface Op {
  ctx: RequestContext;
  action: MediaAction;
  producerId?: string;
}

/**
 * SFU media requests. Each runs in the room's executor after the policy allows it (inRoom),
 * so it cannot interleave with the caller leaving; Producer operations are owner-only there,
 * and the media module checks that every transport and Consumer id belongs to the caller.
 */
export function registerSfuHandlers(router: RequestRouter, rooms: RoomRegistry): void {
  const inSfuRoom = <T>(
    { ctx, action, producerId }: Op,
    task: (media: MediaController, room: Room, participantId: string) => Promise<T>,
  ): Promise<T> => {
    const media = rooms.media;
    const ownerOf = (room: Room) =>
      media?.producers(room.id).find((p) => p.producerId === producerId)?.participantId;
    const run = (room: Room, me: string) => {
      if (room.mode !== 'sfu' || !media) {
        throw new SignalingError('INVALID_STATE', 'not in an SFU room');
      }
      return task(media, room, me);
    };
    return inRoom(ctx, action, run, producerId === undefined ? undefined : ownerOf);
  };

  router
    .on('sfu.createTransport', ({ direction }, ctx) =>
      inSfuRoom({ ctx, action: 'sfu.createTransport' }, (media, room, me) =>
        media.createTransport(room.id, me, direction),
      ),
    )
    .on('sfu.connectTransport', ({ transportId, dtlsParameters }, ctx) =>
      inSfuRoom({ ctx, action: 'sfu.connectTransport' }, async (media, _room, me) => {
        await media.connectTransport(me, transportId, dtlsParameters);
        return {};
      }),
    )
    .on('sfu.produce', ({ transportId, kind, source, rtpParameters }, ctx) =>
      inSfuRoom({ ctx, action: 'sfu.produce' }, async (media, room, me) => {
        const info = await media.produce(me, transportId, kind, source, rtpParameters);
        room.broadcast('sfu.newProducer', info, me); // everyone else consumes it
        return { producerId: info.producerId };
      }),
    )
    .on('sfu.consume', ({ transportId, producerId, rtpCapabilities }, ctx) =>
      inSfuRoom({ ctx, action: 'sfu.consume' }, (media, _room, me) =>
        media.consume(me, transportId, producerId, rtpCapabilities),
      ),
    )
    .on('sfu.resumeConsumer', ({ consumerId }, ctx) =>
      inSfuRoom({ ctx, action: 'sfu.resumeConsumer' }, async (media, _room, me) => {
        await media.resumeConsumer(me, consumerId);
        return {};
      }),
    )
    .on('sfu.closeProducer', ({ producerId }, ctx) =>
      inSfuRoom({ ctx, action: 'sfu.closeProducer', producerId }, (media, _room, me) => {
        media.closeProducer(me, producerId);
        return Promise.resolve({});
      }),
    )
    .on('sfu.pauseProducer', ({ producerId, paused }, ctx) =>
      inSfuRoom({ ctx, action: 'sfu.pauseProducer', producerId }, async (media, _room, me) => {
        await media.pauseProducer(me, producerId, paused);
        return {};
      }),
    );
}
