import type { RoomSnapshot } from '@ts-rtc/protocol';
import { afterEach, expect, test } from 'vitest';
import type { App } from '../src/app.js';
import { captureLogs, startServer, TestClient, type TestDirectory } from './helpers.js';

const quality = {
  peer: 'p2',
  rttMs: 12,
  lossPct: 0.5,
  jitterMs: 3,
  inKbps: 1500,
  outKbps: 1450,
  pairLocal: 'host',
  pairRemote: 'srflx',
  protocol: 'udp',
  limitation: 'none',
};

let app: App | undefined;
afterEach(async () => {
  await app?.close();
});

async function joined({ host, directory }: { host: string; directory: TestDirectory }) {
  const client = await TestClient.greeted(host);
  const roomId = directory.create('mesh');
  const snapshot = await client.ok<RoomSnapshot>('room.join', { roomId });
  return { client, snapshot };
}

test('a quality report is logged per peer, correlated with session, room and participant', async () => {
  const { lines, log } = captureLogs();
  const server = await startServer({}, log);
  app = server.app;
  const { client, snapshot } = await joined(server);
  await client.ok('client.report', { kind: 'quality', peers: [quality] });
  const line = lines.find((l) => l.msg === 'client.quality');
  expect(line).toMatchObject({
    ...quality,
    level: 30,
    service: 'ts-rtc-server',
    env: 'test',
    version: 'v-test',
    roomId: snapshot.roomId,
    participantId: snapshot.participantId,
  });
  expect(line?.sessionId).toEqual(expect.any(String));
});

test('reports are rate-limited per session: quality at most once per 5 s', async () => {
  const server = await startServer();
  app = server.app;
  const { client } = await joined(server);
  await client.ok('client.report', { kind: 'quality', peers: [quality] });
  const second = await client.request('client.report', { kind: 'quality', peers: [quality] });
  expect(second).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryable: true } });
  // state reports have their own budget
  await client.ok('client.report', { kind: 'state', peer: 'p2', state: 'connected' });
});

test('invalid or oversized reports are rejected; unknown fields (addresses) are dropped', async () => {
  const { lines, log } = captureLogs();
  const server = await startServer({}, log);
  app = server.app;
  const { client } = await joined(server);
  const tooMany = Array.from({ length: 11 }, () => quality);
  for (const payload of [
    { kind: 'quality', peers: tooMany },
    { kind: 'quality', peers: [{ ...quality, lossPct: 140 }] },
    { kind: 'raw', stats: {} },
  ]) {
    expect(await client.request('client.report', payload)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
  }
  await client.ok('client.report', {
    kind: 'quality',
    peers: [{ ...quality, localAddress: '192.168.1.7' }],
  });
  expect(JSON.stringify(lines)).not.toContain('192.168.1.7');
});

test('a report outside a room is refused', async () => {
  const server = await startServer();
  app = server.app;
  const client = await TestClient.greeted(server.host);
  expect(await client.request('client.report', { kind: 'quality', peers: [] })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_STATE' },
  });
});

test('secrets never reach the log output, at any level', () => {
  const { lines, log } = captureLogs();
  log.info(
    {
      accessToken: 'tok-123',
      user: { password: 'pw-123' },
      iceServers: [{ urls: 'turn:x', username: 'u', credential: 'cred-123' }],
      signal: { description: { type: 'offer', sdp: 'v=0 sdp-123' } },
      candidate: { candidate: 'candidate:1 1 udp 1 203.0.113.9 5000 typ host' },
    },
    'request.debug',
  );
  const output = JSON.stringify(lines);
  for (const secret of ['tok-123', 'pw-123', 'cred-123', 'sdp-123', '203.0.113.9']) {
    expect(output).not.toContain(secret);
  }
  expect(output).toContain('[redacted]');
});
