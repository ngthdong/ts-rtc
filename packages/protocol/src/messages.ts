import { z } from 'zod';

export const SessionHello = z.object({
  protocolVersions: z.array(z.number().int().positive()).min(1).max(10),
});
export const SessionWelcome = z.object({
  sessionId: z.string(),
  protocolVersion: z.number().int().positive(),
  heartbeatIntervalMs: z.number().int().positive(),
});
export const SessionHeartbeat = z.object({});
export const SessionHeartbeatAck = z.object({ serverTime: z.number() });

export const Member = z.object({ participantId: z.string(), displayName: z.string() });
export type Member = z.infer<typeof Member>;

export const RoomSnapshot = z.object({
  roomId: z.string(),
  participantId: z.string(),
  roomSeq: z.number().int().nonnegative(),
  mode: z.literal('mesh'),
  members: z.array(Member),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshot>;

export const LeaveReason = z.enum(['left', 'disconnected']);
export type LeaveReason = z.infer<typeof LeaveReason>;

export const RoomCreate = z.object({});
export const RoomCreated = z.object({ roomId: z.string() });
export const RoomJoin = z.object({
  roomId: z.string().min(1).max(64),
  displayName: z.string().trim().min(1).max(64),
});
export const RoomLeave = z.object({});
export const RoomLeft = z.object({});
export const RoomSync = z.object({});

export const Requests = {
  'session.hello': { request: SessionHello, response: SessionWelcome },
  'session.heartbeat': { request: SessionHeartbeat, response: SessionHeartbeatAck },
  'room.create': { request: RoomCreate, response: RoomCreated },
  'room.join': { request: RoomJoin, response: RoomSnapshot },
  'room.leave': { request: RoomLeave, response: RoomLeft },
  'room.sync': { request: RoomSync, response: RoomSnapshot },
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
} as const;

export type EventType = keyof typeof Events;
export type EventPayload<T extends EventType> = z.infer<(typeof Events)[T]>;
export type SignalingEvent = { [T in EventType]: { type: T; payload: EventPayload<T> } }[EventType];

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(Events, type);
}
