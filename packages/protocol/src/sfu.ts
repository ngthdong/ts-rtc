import { z } from 'zod';

/** mediasoup parameters: produced and checked by mediasoup on both ends, opaque in between. */
const Opaque = z.record(z.string(), z.unknown());
const Id = z.string().min(1).max(64);
export const MediaKind = z.enum(['audio', 'video']);
export type MediaKind = z.infer<typeof MediaKind>;

/** SFU requests. Every id names something the server checks the caller owns. */
export const SfuRequests = {
  'sfu.createTransport': {
    request: z.object({ direction: z.enum(['send', 'recv']) }),
    response: z.object({
      transportId: Id,
      iceParameters: Opaque,
      iceCandidates: z.array(Opaque),
      dtlsParameters: Opaque,
    }),
  },
  'sfu.connectTransport': {
    request: z.object({ transportId: Id, dtlsParameters: Opaque }),
    response: z.object({}),
  },
  'sfu.produce': {
    request: z.object({ transportId: Id, kind: MediaKind, rtpParameters: Opaque }),
    response: z.object({ producerId: Id }),
  },
  'sfu.consume': {
    request: z.object({ transportId: Id, producerId: Id, rtpCapabilities: Opaque }),
    response: z.object({
      consumerId: Id,
      producerId: Id,
      kind: MediaKind,
      rtpParameters: Opaque,
    }),
  },
} as const;

export const SfuEvents = {
  /** The server closed one of your transports: never connected, DTLS failed, ICE gone 30 s. */
  'sfu.transportClosed': z.object({
    transportId: Id,
    reason: z.enum(['connect_timeout', 'dtls_failed', 'dtls_closed', 'ice_disconnected']),
  }),
} as const;
