import { expect, test } from 'vitest';
import { DebugEchoRequest, PROTOCOL_VERSION } from './index.js';

test('protocol version is 1', () => {
  expect(PROTOCOL_VERSION).toBe(1);
});

test('debug.echo accepts a short string and rejects anything else', () => {
  expect(DebugEchoRequest.safeParse({ type: 'debug.echo', payload: 'hi' }).success).toBe(true);
  expect(DebugEchoRequest.safeParse({ type: 'debug.echo', payload: 42 }).success).toBe(false);
  expect(
    DebugEchoRequest.safeParse({ type: 'debug.echo', payload: 'x'.repeat(1001) }).success,
  ).toBe(false);
});
