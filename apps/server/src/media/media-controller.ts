import type {
  EventPayload,
  ProducerInfo,
  ProducerSource,
  RequestPayload,
  ResponsePayload,
  SignalingEvent,
} from '@ts-rtc/protocol';

/** mediasoup parameters as plain JSON (RTP capabilities, ICE/DTLS/RTP parameters). */
export type Json = Record<string, unknown>;
export type RtpCapabilities = Json;
// The wire shapes are the protocol's: one definition for client, server and media module.
export type Direction = RequestPayload<'sfu.createTransport'>['direction'];
export type MediaKind = RequestPayload<'sfu.produce'>['kind'];
export type TransportParams = ResponsePayload<'sfu.createTransport'>;
export type ConsumerParams = ResponsePayload<'sfu.consume'>;
export type TransportCloseReason = EventPayload<'sfu.transportClosed'>['reason'];
/** What the media module tells one participant on its own (the room delivers it). */
export type MediaEvent = Extract<
  SignalingEvent,
  { type: 'sfu.transportClosed' | 'sfu.consumerClosed' }
>;

/** Live mediasoup objects, counted from their own create/close events: leaks show up here. */
export interface MediaCounts {
  transports: number;
  producers: number;
  consumers: number;
}

/** Per-Worker numbers for tests, the dev dump and metrics. */
export interface WorkerInfo {
  index: number;
  pid: number;
  routerIds: string[];
  usage: Record<string, number>;
}

/**
 * The SFU as the rest of the server sees it. Rooms ask by room id; nothing outside
 * `media/` imports mediasoup, and no mediasoup object crosses this boundary.
 */
export interface MediaController {
  /** Creates the room's Router on the least-loaded Worker, or returns the existing one. */
  ensureRouter(roomId: string): Promise<RtpCapabilities>;
  /** Idempotent; also safe while ensureRouter for the room is still in flight. */
  closeRouter(roomId: string): void;
  /** The room's current Router, once created: a new id after a Worker died and it was replaced. */
  routerId(roomId: string): string | undefined;
  /** Called with each room whose Router was lost because its Worker died. */
  onRouterLost(listener: (roomId: string) => void): void;
  /**
   * Media for a participant of the room. Every call names transports and Producers by id and
   * checks that the caller owns them (or, for consume, that the Producer is in the same room).
   */
  createTransport(
    roomId: string,
    participantId: string,
    direction: Direction,
  ): Promise<TransportParams>;
  connectTransport(participantId: string, transportId: string, dtlsParameters: Json): Promise<void>;
  produce(
    participantId: string,
    transportId: string,
    kind: MediaKind,
    source: ProducerSource,
    rtpParameters: Json,
  ): Promise<ProducerInfo>;
  /** Consumers start paused: call resumeConsumer once the client has attached the track. */
  consume(
    participantId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Json,
  ): Promise<ConsumerParams>;
  resumeConsumer(participantId: string, consumerId: string): Promise<void>;
  pauseProducer(participantId: string, producerId: string, paused: boolean): Promise<void>;
  closeProducer(participantId: string, producerId: string): void;
  /** New ICE parameters for one of the caller's transports (client-side ICE restart). */
  restartIce(participantId: string, transportId: string): Promise<Json>;
  /** The participant's open transports: after a resume, the client rebuilds the missing ones. */
  transportsOf(participantId: string): string[];
  /** Closes a transport as if it had failed (its owner gets sfu.transportClosed). Dev route. */
  closeTransport(transportId: string): boolean;
  /** The room's open Producers, for the join snapshot. */
  producers(roomId: string): ProducerInfo[];
  /** Closes the participant's transports (and so its Producers and Consumers). Idempotent. */
  closeParticipant(participantId: string): void;
  /** Events for one participant (transport closed by the server, Consumer lost its Producer). */
  onEvent(listener: (roomId: string, participantId: string, event: MediaEvent) => void): void;
  /** The room's dominant speaker changed, already debounced (SpeakerGate). */
  onActiveSpeaker(listener: (roomId: string, participantId: string) => void): void;
  counts(): MediaCounts;
  /** False once Workers die faster than they may be restarted: /readyz answers 503. */
  readonly healthy: boolean;
  inspect(): Promise<WorkerInfo[]>;
  close(): void;
}
