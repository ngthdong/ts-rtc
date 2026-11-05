import { z } from 'zod';
import { ProducerInfo, SfuEvents, SfuRequests } from './sfu.js';

export const SessionHello = z.object({
  protocolVersions: z.array(z.number().int().positive()).min(1).max(10),
  /** From POST /api/auth/login. Missing or invalid: the server closes with 4401. */
  accessToken: z.string().max(4_096).optional(),
});

export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string()).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

export const SessionWelcome = z.object({
  sessionId: z.string(),
  protocolVersion: z.number().int().positive(),
  heartbeatIntervalMs: z.number().int().positive(),
  iceServers: z.array(IceServer),
});
export const SessionHeartbeat = z.object({});
export const SessionHeartbeatAck = z.object({ serverTime: z.number() });

export const MuteState = z.object({ audioMuted: z.boolean(), videoMuted: z.boolean() });
export type MuteState = z.infer<typeof MuteState>;

/** reconnecting: the member's socket dropped; it has a grace period to resume (room.resume). */
export const ConnectionState = z.enum(['connected', 'reconnecting']);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const Member = z
  .object({ participantId: z.string(), displayName: z.string(), connection: ConnectionState })
  .extend(MuteState.shape);
export type Member = z.infer<typeof Member>;

/** mesh: browsers connect to each other. sfu: every browser connects to the media server. */
export const RoomMode = z.enum(['mesh', 'sfu']);
export type RoomMode = z.infer<typeof RoomMode>;

/** The full membership of a room as of `roomSeq`; events with a higher roomSeq follow. */
export const RoomSnapshot = z.object({
  roomId: z.string(),
  participantId: z.string(),
  roomSeq: z.number().int().nonnegative(),
  mode: RoomMode,
  members: z.array(Member),
  /** SFU rooms: the Router's RTP capabilities, opaque here, loaded by mediasoup-client. */
  routerRtpCapabilities: z.record(z.string(), z.unknown()).optional(),
  /** SFU rooms: the Router in use. A new one (its Worker died) means media must be rebuilt. */
  routerId: z.string().optional(),
  /** SFU rooms: everyone else's current Producers; later ones arrive as sfu.newProducer. */
  producers: z.array(ProducerInfo).optional(),
  /** SFU rooms: the current dominant speaker, if one is known and still here. */
  activeSpeaker: z.string().optional(),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshot>;

/** room.join and room.resume: the snapshot, plus what a later reconnect needs. */
export const JoinResult = RoomSnapshot.extend({
  /**
   * `<room>.<participant>.<secret>`: room.resume on a new socket gets this membership back
   * within the grace period. A new one on every join and resume; the previous one stops working.
   */
  resumeToken: z.string(),
  /** room.resume in SFU rooms: your transports that still exist on the server. */
  transportIds: z.array(z.string()).optional(),
});
export type JoinResult = z.infer<typeof JoinResult>;

export const MeshSignal = z.union([
  z.object({
    description: z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().max(32_768) }),
  }),
  z.object({
    candidate: z.object({
      candidate: z.string().max(1_024),
      sdpMid: z.string().max(64).nullish(),
      sdpMLineIndex: z.number().int().min(0).max(255).nullish(),
      usernameFragment: z.string().max(256).nullish(),
    }),
  }),
]);
export type MeshSignal = z.infer<typeof MeshSignal>;

/** timeout: the connection dropped and no resume came within the grace period. */
export const LeaveReason = z.enum(['left', 'timeout']);
export type LeaveReason = z.infer<typeof LeaveReason>;

const CandidateType = z.enum(['host', 'srflx', 'prflx', 'relay']);
const Rate = z.number().min(0).max(1e6).nullable();

/** One peer's quality over the last sampling window: derived numbers only, no addresses. */
export const PeerQualityReport = z.object({
  peer: z.string().max(64),
  rttMs: Rate,
  lossPct: z.number().min(0).max(100).nullable(),
  jitterMs: Rate,
  inKbps: Rate,
  outKbps: Rate,
  pairLocal: CandidateType.nullable(),
  pairRemote: CandidateType.nullable(),
  protocol: z.enum(['udp', 'tcp']).nullable(),
  limitation: z.enum(['none', 'cpu', 'bandwidth', 'other']).nullable(),
});
export type PeerQualityReport = z.infer<typeof PeerQualityReport>;

/** Client telemetry, rate-limited per session and written to the server log. */
export const ClientReport = z.union([
  z.object({ kind: z.literal('quality'), peers: z.array(PeerQualityReport).max(10) }),
  z.object({
    kind: z.literal('state'),
    peer: z.string().max(64),
    state: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
  }),
]);
export type ClientReport = z.infer<typeof ClientReport>;

export const Empty = z.object({});

/** Rooms are created over HTTP (POST /api/rooms); the display name is the account's. */
export const RoomJoin = z.object({ roomId: z.string().min(1).max(64) });
export const RoomResume = z.object({ resumeToken: z.string().min(1).max(256) });
export const RoomLeave = z.object({});
export const RoomLeft = z.object({});
export const RoomSync = z.object({});

export const Requests = {
  'session.hello': { request: SessionHello, response: SessionWelcome },
  'session.heartbeat': { request: SessionHeartbeat, response: SessionHeartbeatAck },
  'room.join': { request: RoomJoin, response: JoinResult },
  /** After a reconnect: the same participant, if its grace period is not over (else NOT_FOUND). */
  'room.resume': { request: RoomResume, response: JoinResult },
  'room.leave': { request: RoomLeave, response: RoomLeft },
  'room.sync': { request: RoomSync, response: RoomSnapshot },
  'participant.update': { request: MuteState, response: Empty },
  'client.report': { request: ClientReport, response: Empty },
  'mesh.signal': {
    request: z.object({ to: z.string().max(64), signal: MeshSignal }),
    response: Empty,
  },
  ...SfuRequests,
} as const;

export type RequestType = keyof typeof Requests;
export type RequestPayload<T extends RequestType> = z.infer<(typeof Requests)[T]['request']>;
export type ResponsePayload<T extends RequestType> = z.infer<(typeof Requests)[T]['response']>;

export function isRequestType(type: string): type is RequestType {
  return Object.hasOwn(Requests, type);
}

// Room events carry `roomSeq` (+1 per membership change) so a member can apply them in order.
export const Events = {
  'participant.joined': z.object({ roomSeq: z.number().int().positive(), participant: Member }),
  'participant.left': z.object({
    roomSeq: z.number().int().positive(),
    participantId: z.string(),
    reason: LeaveReason,
  }),
  'participant.updated': z
    .object({
      roomSeq: z.number().int().positive(),
      participantId: z.string(),
      connection: ConnectionState,
    })
    .extend(MuteState.shape),
  /** The room ended for everyone; members are no longer bound to it. No roomSeq: it is final. */
  'room.closed': z.object({ reason: z.enum(['media_failure', 'deleted']) }),
  'mesh.signal': z.object({ from: z.string(), signal: MeshSignal }),
  /** Another connection resumed your session; this socket closes next (4409). */
  'session.replaced': z.object({}),
  ...SfuEvents,
} as const;

export type EventType = keyof typeof Events;
export type EventPayload<T extends EventType> = z.infer<(typeof Events)[T]>;
export type SignalingEvent = { [T in EventType]: { type: T; payload: EventPayload<T> } }[EventType];

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(Events, type);
}
