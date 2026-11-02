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
  close() {
    this.readyState = 3;
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
let socket: FakeSocket;
let client: SignalingClient;

beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket();
  client = new SignalingClient('ws://test/ws', {
    createSocket: () => socket as unknown as WebSocket,
  });
});
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

test('two missed heartbeats close the connection from the client side', async () => {
  socket.open();
  socket.reply(socket.sent[0], welcome);
  await vi.waitFor(() => {
    expect(client.snapshot.status).toBe('ready');
  });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(client.snapshot).toMatchObject({ status: 'closed', closeReason: 'heartbeat timeout' });
});
