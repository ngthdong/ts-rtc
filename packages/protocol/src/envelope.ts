import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const ErrorCode = z.enum([
  'INVALID_PAYLOAD',
  'UNKNOWN_TYPE',
  'UNSUPPORTED_VERSION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE',
  'RATE_LIMITED',
  'CAPACITY_EXCEEDED',
  'TIMEOUT',
  'UNAVAILABLE',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'RATE_LIMITED',
  'CAPACITY_EXCEEDED',
  'TIMEOUT',
  'UNAVAILABLE',
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  UnsupportedData: 1003,
  InvalidPayload: 1007,
  MessageTooBig: 1009,
  TryAgainLater: 1013,
  UnsupportedVersion: 4400,
  /** No valid access token in session.hello: sign in again (like HTTP 401). */
  Unauthenticated: 4401,
  HandshakeTimeout: 4408,
  /** Another connection resumed this session (room.resume): this one must not reconnect. */
  Replaced: 4409,
} as const;

export const ClientRequest = z.object({
  v: z.number().int().positive(),
  kind: z.literal('req'),
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  payload: z.unknown(),
});
export type ClientRequest = z.infer<typeof ClientRequest>;

export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

const responseBase = {
  v: z.number().int().positive(),
  kind: z.literal('res'),
  id: z.string(),
  type: z.string(),
};

export const ServerMessage = z.union([
  z.object({ ...responseBase, ok: z.literal(true), payload: z.unknown() }),
  z.object({ ...responseBase, ok: z.literal(false), error: ErrorBody }),
  z.object({
    v: z.number().int().positive(),
    kind: z.literal('evt'),
    type: z.string(),
    seq: z.number().int().positive(),
    payload: z.unknown(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerResponse = Extract<ServerMessage, { kind: 'res' }>;

export class SignalingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly closeCode?: number,
    options?: ErrorOptions, // { cause }: the underlying error, for logs
  ) {
    super(message, options);
    this.name = 'SignalingError';
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}
