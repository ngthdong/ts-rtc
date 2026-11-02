import { describe, expect, test } from 'vitest';
import { ClientRequest, ErrorCode, isRetryable, Requests, ServerMessage } from './index.js';

describe('envelope', () => {
  test('accepts a well-formed request and rejects a missing id', () => {
    const req = { v: 1, kind: 'req', id: '1', type: 'session.heartbeat', payload: {} };
    expect(ClientRequest.safeParse(req).success).toBe(true);
    expect(ClientRequest.safeParse({ ...req, id: '' }).success).toBe(false);
  });

  test('parses ok responses, error responses and events', () => {
    const base = { v: 1, kind: 'res', id: '1', type: 'session.heartbeat' };
    const error = { code: 'TIMEOUT', message: 'late', retryable: true };
    expect(ServerMessage.safeParse({ ...base, ok: true, payload: {} }).success).toBe(true);
    expect(ServerMessage.safeParse({ ...base, ok: false, error }).success).toBe(true);
    expect(ServerMessage.safeParse({ ...base, ok: false }).success).toBe(false);
    const evt = { v: 1, kind: 'evt', type: 'x', seq: 1, payload: {} };
    expect(ServerMessage.safeParse(evt).success).toBe(true);
  });

  test('only transient error codes are retryable', () => {
    const retryable = ErrorCode.options.filter(isRetryable);
    expect(retryable).toEqual(['RATE_LIMITED', 'CAPACITY_EXCEEDED', 'TIMEOUT', 'UNAVAILABLE']);
  });
});

describe('session messages', () => {
  test('hello needs at least one protocol version', () => {
    const hello = Requests['session.hello'].request;
    expect(hello.safeParse({ protocolVersions: [1] }).success).toBe(true);
    expect(hello.safeParse({ protocolVersions: [] }).success).toBe(false);
  });

  test('unknown fields are stripped, not rejected', () => {
    const parsed = Requests['session.hello'].request.parse({ protocolVersions: [1], extra: true });
    expect(parsed).toEqual({ protocolVersions: [1] });
  });
});
