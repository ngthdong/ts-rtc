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

export const Requests = {
  'session.hello': { request: SessionHello, response: SessionWelcome },
  'session.heartbeat': { request: SessionHeartbeat, response: SessionHeartbeatAck },
} as const;

export type RequestType = keyof typeof Requests;
export type RequestPayload<T extends RequestType> = z.infer<(typeof Requests)[T]['request']>;
export type ResponsePayload<T extends RequestType> = z.infer<(typeof Requests)[T]['response']>;

export function isRequestType(type: string): type is RequestType {
  return Object.hasOwn(Requests, type);
}
