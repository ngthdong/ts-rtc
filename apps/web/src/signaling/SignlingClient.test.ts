import type { ClientRequest } from '@ts-rtc/protocol';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SignalingClient } from './SignalingClient.js';

class FakeSocket {
  readyState = 0;
  sent: ClientRequest[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientRequest);
  }
  closedWith: number | undefined;
  close(code?: number) {
    this.readyState = 3;
    this.closedWith = code;
  }
  /** The server (or the network) closes it. */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  reply(request: ClientRequest | undefined, payload: unknown) {
    if (!request) throw new Error('no request to reply to');
    const message = { v: 1, kind: 'res', id: request.id, type: request.type, ok: true, payload };
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const welcome = {
  sessionId: 's-1',
  protocolVersion: 1,
  heartbeatIntervalMs: 10_000,
  iceServers: [],
};
let sockets: FakeSocket[];
let socket: FakeSocket;
let client: SignalingClient;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  client = new SignalingClient('ws://test/ws', {
    random: () => 1, // the longest delay of each attempt
    createSocket: () => {
      socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
});

/** Opens the current socket and answers its hello. */
async function greet() {
  socket.open();
  socket.reply(socket.sent[0], welcome);
  await vi.waitFor(() => {
    expect(client.snapshot.status).toBe('ready');
  });
}
afterEach(() => {
  vi.useRealTimers();
});

test('sends hello on open and becomes ready on welcome', async () => {
  socket.open();
  expect(socket.sent[0]).toMatchObject({
    type: 'session.hello',
    payload: { protocolVersions: [1] },
  });
  socket.reply(socket.sent[0], welcome);
  await vi.waitFor(() => {
    expect(client.snapshot).toMatchObject({ status: 'ready', sessionId: 's-1' });
  });
});

test('matches responses by id, not by arrival order', async () => {
  socket.open();
  socket.reply(socket.sent[0], welcome);
  const first = client.request('session.heartbeat', {});
  const second = client.request('session.heartbeat', {});
  socket.reply(socket.sent[2], { serverTime: 2 });
  socket.reply(socket.sent[1], { serverTime: 1 });
  await expect(first).resolves.toEqual({ serverTime: 1 });
  await expect(second).resolves.toEqual({ serverTime: 2 });
});

test('a request with no answer rejects with TIMEOUT', async () => {
  socket.open();
  const pending = client.request('session.heartbeat', {}, 1_000);
  vi.advanceTimersByTime(1_000);
  await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
});

test('two missed heartbeats drop the socket from the client side, and it reconnects', async () => {
  await greet();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(client.snapshot).toMatchObject({
    status: 'reconnecting',
    closeReason: 'heartbeat timeout',
  });
  expect(sockets[0]?.readyState).toBe(3);
});

test('a dropped socket is replaced with backoff: hello again, a new session', async () => {
  await greet();
  socket.drop();
  expect(client.snapshot.status).toBe('reconnecting');
  await vi.advanceTimersByTimeAsync(499);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); // attempt 0: up to 500 ms
  expect(sockets).toHaveLength(2);
  socket.drop(); // the new socket fails too: attempt 1, up to 1 s
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets).toHaveLength(3);
  socket.open();
  expect(socket.sent[0]).toMatchObject({ type: 'session.hello' });
  socket.reply(socket.sent[0], { ...welcome, sessionId: 's-2' });
  await vi.waitFor(() => {
    expect(client.snapshot).toMatchObject({ status: 'ready', sessionId: 's-2' });
  });
});

test('back online: the next attempt is made now, not after the backoff', async () => {
  let online: (() => void) | undefined;
  vi.stubGlobal('addEventListener', (type: string, listener: () => void) => {
    if (type === 'online') online = listener;
  });
  vi.stubGlobal('removeEventListener', () => undefined);
  client = new SignalingClient('ws://test/ws', {
    random: () => 1,
    createSocket: () => (sockets.push((socket = new FakeSocket())), socket as unknown as WebSocket),
  });
  const before = sockets.length;
  socket.drop();
  for (let attempt = 0; attempt < 4; attempt++) {
    await vi.advanceTimersByTimeAsync(10_000);
    socket.drop(); // now waiting up to 8 s
  }
  const waiting = sockets.length;
  online?.();
  expect(sockets).toHaveLength(waiting + 1);
  expect(waiting).toBe(before + 4);
  vi.unstubAllGlobals();
});

test('final closes (signed out, replaced, deliberate) are not retried', async () => {
  for (const code of [4401, 4409]) {
    const before = sockets.length;
    socket.drop(code);
    expect(client.snapshot).toMatchObject({ status: 'closed', closeCode: code });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(before);
    client = new SignalingClient('ws://test/ws', {
      createSocket: () => (
        sockets.push((socket = new FakeSocket())),
        socket as unknown as WebSocket
      ),
    });
  }
  client.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.snapshot).toMatchObject({ status: 'closed', closeCode: 1000 });
  expect(socket.closedWith).toBe(1000);
});

test('after 8 failed attempts it gives up: closed, no more sockets', async () => {
  socket.drop();
  for (let attempt = 0; attempt < 8; attempt++) {
    await vi.advanceTimersByTimeAsync(10_000);
    socket.drop();
  }
  expect(sockets).toHaveLength(9);
  expect(client.snapshot.status).toBe('closed');
});

test('drop(ms): the socket closes now, and no new one opens before ms have passed', async () => {
  await greet();
  client.drop(3_000);
  expect(sockets[0]?.closedWith).toBe(4000);
  expect(client.snapshot.status).toBe('reconnecting');
  await vi.advanceTimersByTimeAsync(2_999);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
});
