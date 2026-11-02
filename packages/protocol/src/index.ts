import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const DebugEchoRequest = z.object({
  type: z.literal('debug.echo'),
  payload: z.string().max(1000),
});
export type DebugEchoRequest = z.infer<typeof DebugEchoRequest>;

export interface DebugEchoReply {
  type: 'debug.echo';
  payload: string;
  sessionId: string;
}

export * from './envelope.js';
export * from './messages.js';
