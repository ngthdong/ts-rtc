import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import { expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RequestRouter } from '../src/router.js';
import { Session } from '../src/session.js';

const log = pino({ level: 'silent' });
const ctx = { session: { greeted: true } as Session, log };
const heartbeat = { v: 1, kind: 'req', id: '1', type: 'session.heartbeat', payload: {} } as const;

test('a handler that outlives the deadline yields TIMEOUT', async () => {
  const router = new RequestRouter(20).on('session.heartbeat', () => new Promise(() => {}));
  const { response } = await router.dispatch(heartbeat, ctx);
  expect(response).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
});

test('an unexpected exception yields INTERNAL without leaking its message', async () => {
  const router = new RequestRouter(1000).on('session.heartbeat', () => {
    throw new Error('db password is hunter2');
  });
  const { response } = await router.dispatch(heartbeat, ctx);
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INTERNAL', message: 'internal error' },
  });
});

test('a slow consumer is closed with 1013 instead of buffering more', () => {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 2_000_000,
    send: vi.fn(),
    close: vi.fn(),
  });
  const options = { helloTimeoutMs: 60_000, pingIntervalMs: 60_000, maxBufferedBytes: 1_000_000 };
  const session = new Session(
    socket as unknown as WebSocket,
    log,
    new RequestRouter(1000),
    options,
  );
  session.send({ v: 1, kind: 'evt', type: 'x', seq: 1, payload: {} });
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledWith(1013, 'slow consumer');
  socket.emit('close', 1013);
});
