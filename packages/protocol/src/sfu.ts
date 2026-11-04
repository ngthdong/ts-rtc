import { z } from 'zod';

/** mediasoup parameters: produced and checked by mediasoup on both ends, opaque in between. */
const Opaque = z.record(z.string(), z.unknown());
const Id = z.string().min(1).max(64);
export const MediaKind = z.enum(['audio', 'video']);
export type MediaKind = z.infer<typeof MediaKind>;
/** What a Producer carries; at most one per source and participant, one screen per room. */
export const ProducerSource = z.enum(['mic', 'camera', 'screen']);
export type ProducerSource = z.infer<typeof ProducerSource>;

/** A Producer as other members learn about it: in the join snapshot and in sfu.newProducer. */
export const ProducerInfo = z.object({
  producerId: Id,
  participantId: Id,
  kind: MediaKind,
  source: ProducerSource,
});
export type ProducerInfo = z.infer<typeof ProducerInfo>;

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
    request: z.object({
      transportId: Id,
      kind: MediaKind,
      source: ProducerSource,
      rtpParameters: Opaque,
    }),
    response: z.object({ producerId: Id }),
  },
  'sfu.consume': {
    request: z.object({ transportId: Id, producerId: Id, rtpCapabilities: Opaque }),
    response: z.object({
      consumerId: Id,
      producerId: Id,
      kind: MediaKind,
      rtpParameters: Opaque,
      producerPaused: z.boolean(),
    }),
  },
  /** Consumers start paused; resume once the track is attached, so no key frame is lost. */
  'sfu.resumeConsumer': { request: z.object({ consumerId: Id }), response: z.object({}) },
  /** Stop a Producer for good (screen share ended). Its Consumers get sfu.consumerClosed. */
  'sfu.closeProducer': { request: z.object({ producerId: Id }), response: z.object({}) },
  /** Mute: the Worker stops forwarding this Producer to everyone. Own Producers only. */
  'sfu.pauseProducer': {
    request: z.object({ producerId: Id, paused: z.boolean() }),
    response: z.object({}),
  },
} as const;

export const SfuEvents = {
  /** Another member started sending: consume it. Not sent to the producer itself. */
  'sfu.newProducer': ProducerInfo,
  /** A Consumer of yours ended because its Producer closed (its owner left or stopped). */
  'sfu.consumerClosed': z.object({ consumerId: Id, reason: z.enum(['producer_closed']) }),
  /** The room's dominant speaker changed (debounced); room state, ordered by roomSeq. */
  'sfu.activeSpeaker': z.object({ roomSeq: z.number().int().positive(), participantId: Id }),
  /** The server closed one of your transports: never connected, DTLS failed, ICE gone 30 s. */
  'sfu.transportClosed': z.object({
    transportId: Id,
    reason: z.enum(['connect_timeout', 'dtls_failed', 'dtls_closed', 'ice_disconnected']),
  }),
} as const;
