import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { postgresDirectory } from '../src/auth/directory.js';
import { Tokens } from '../src/auth/tokens.js';
import { createPool, migrate, type Db } from '../src/db/pool.js';
import { RateLimiter } from '../src/http/rate-limit.js';
import { captureLogs, TestClient } from './helpers.js';

// The HTTP API and Postgres-backed signaling. Needs a Postgres whose user may create
// databases, e.g. TEST_DATABASE_URL=postgres://ts_rtc:ts_rtc@127.0.0.1:5432/ts_rtc (compose.yaml).
const { TEST_DATABASE_URL } = process.env;
const PASSWORD = 'correct horse battery staple';
const tokens = new Tokens({
  secret: 't'.repeat(32),
  issuer: 'ts-rtc',
  audience: 'ts-rtc',
  ttlSeconds: 600,
});

type Body = Record<string, unknown>;

/** A server with the API (and /api/openapi.json) and Postgres-backed signaling. */
async function serve(db: Db, log: FastifyBaseLogger = pino({ level: 'silent' })) {
  const app = buildApp(log, {
    directory: postgresDirectory(db, tokens),
    api: { db, tokens, limiter: new RateLimiter(10_000, 10_000) },
    debugRoutes: true,
  });
  await app.http.listen({ host: '127.0.0.1', port: 0 });
  const host = `127.0.0.1:${String((app.http.server.address() as AddressInfo).port)}`;
  /** One API call: the status and the parsed body (undefined for 204). */
  const call = async (method: string, path: string, body?: object, token?: string) => {
    const res = await fetch(`http://${host}${path}`, {
      method,
      headers: {
        ...(body && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Body };
  };
  /** A signaling connection that said hello with `token`. */
  const signIn = async (token: string) => {
    const client = await TestClient.connect(host);
    await client.ok('session.hello', { protocolVersions: [1], accessToken: token });
    return client;
  };
  return { app, host, call, signIn };
}

describe.skipIf(!TEST_DATABASE_URL)('with Postgres', () => {
  const name = `ts_rtc_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  let db: Db;
  let applied: string[];
  let server: Awaited<ReturnType<typeof serve>>;

  /** Registers and signs in a fresh account; its token, id and email. */
  async function account(displayName: string) {
    const email = `${displayName.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
    const created = await server.call('POST', '/api/auth/register', {
      email,
      password: PASSWORD,
      displayName,
    });
    expect(created.status).toBe(201);
    const login = await server.call('POST', '/api/auth/login', { email, password: PASSWORD });
    return { token: String(login.body.accessToken), id: String(created.body.id), email };
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`create database ${name}`);
    const url = new URL(TEST_DATABASE_URL ?? '');
    url.pathname = `/${name}`;
    db = createPool(url.href);
    applied = await migrate(db);
    server = await serve(db);
  });
  afterAll(async () => {
    await server.app.close();
    await db.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  });

  test('migrations run once, in order, and create the schema', async () => {
    expect(applied).toEqual(['0001_init.sql']);
    expect(await migrate(db)).toEqual([]); // a second server start applies nothing
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'room_members',
      'rooms',
      'schema_migrations',
      'users',
    ]);
  });

  test('20 concurrent registrations of one email (any case): exactly one 201', async () => {
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        server.call('POST', '/api/auth/register', {
          email: i % 2 ? 'Race@Example.test' : 'race@example.test',
          password: PASSWORD,
          displayName: `R${String(i)}`,
        }),
      ),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([201, ...Array<number>(19).fill(409)]);
  });

  test('sign-in: a wrong password and an unknown email get the same answer; the API needs a token', async () => {
    const { email, token } = await account('Lena');
    const wrong = await server.call('POST', '/api/auth/login', { email, password: 'nope' });
    const unknown = await server.call('POST', '/api/auth/login', {
      email: 'nobody@example.test',
      password: 'nope',
    });
    expect(wrong).toEqual(unknown); // nothing tells whether the account exists
    expect(wrong.status).toBe(401);
    expect((await server.call('GET', '/api/rooms')).status).toBe(401);
    expect((await server.call('GET', '/api/rooms', undefined, 'garbage')).status).toBe(401);
    expect((await server.call('GET', '/api/rooms', undefined, token)).status).toBe(200);
  });

  test('a private room: members only, owner-only changes, deletion ends the call and cascades', async () => {
    const [alice, bob, carol] = [
      await account('Alice'),
      await account('Bob'),
      await account('Carol'),
    ];
    const created = await server.call(
      'POST',
      '/api/rooms',
      { name: 'Standup', visibility: 'private', mode: 'mesh' }, // no SFU in this server
      alice.token,
    );
    expect(created).toMatchObject({ status: 201, body: { visibility: 'private', mode: 'mesh' } });
    const roomId = String(created.body.id);
    const bobWs = await server.signIn(bob.token);
    expect(await bobWs.request('room.join', { roomId })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });

    const add = (token: string) =>
      server.call('POST', `/api/rooms/${roomId}/members`, { email: bob.email }, token);
    expect((await add(carol.token)).status).toBe(403); // not the owner
    expect((await add(alice.token)).status).toBe(204);
    // The next join sees the membership: nothing is cached.
    const joined = await bobWs.ok<{ members: { displayName: string }[] }>('room.join', { roomId });
    expect(joined.members.map((m) => m.displayName)).toEqual(['Bob']); // the account's name

    expect(
      (await server.call('DELETE', `/api/rooms/${roomId}`, undefined, alice.token)).status,
    ).toBe(204);
    expect(await bobWs.waitForEvent('room.closed')).toEqual({
      type: 'room.closed',
      payload: { reason: 'deleted' },
    });
    const left = await db.query('select 1 from room_members where room_id = $1', [roomId]);
    expect(left.rowCount).toBe(0); // the membership went with the room
    expect(await bobWs.request('room.join', { roomId })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    bobWs.close();
  });

  test('passwords, hashes and tokens never reach the log', async () => {
    const { lines, log } = captureLogs();
    const logged = await serve(db, log);
    try {
      const email = `log-${randomUUID().slice(0, 8)}@example.test`;
      await logged.call('POST', '/api/auth/register', {
        email,
        password: PASSWORD,
        displayName: 'L',
      });
      await logged.call('POST', '/api/auth/login', { email, password: 'wrong password' });
      const login = await logged.call('POST', '/api/auth/login', { email, password: PASSWORD });
      const token = String(login.body.accessToken);
      const client = await logged.signIn(token);
      await logged.call('GET', '/api/rooms', undefined, token);
      client.close();
      const text = JSON.stringify(lines);
      expect(text).toContain('auth.login_failed'); // the failure is logged…
      for (const secret of [PASSWORD, 'wrong password', token, '$argon2']) {
        expect(text).not.toContain(secret); // …without anything that would help an attacker
      }
    } finally {
      await logged.app.close();
    }
  });
});

test('Postgres unreachable: the API answers 503 (retryable), hello fails and closes with 1013', async () => {
  const down = createPool('postgres://ts_rtc:ts_rtc@127.0.0.1:1/none'); // nothing listens there
  const server = await serve(down);
  try {
    const login = await server.call('POST', '/api/auth/login', {
      email: 'a@example.test',
      password: PASSWORD,
    });
    expect(login).toEqual({
      status: 503,
      body: { error: { code: 'UNAVAILABLE', message: 'database unavailable', retryable: true } },
    });
    const client = await TestClient.connect(server.host);
    const hello = await client.request('session.hello', {
      protocolVersions: [1],
      accessToken: await tokens.sign(randomUUID()), // valid: the user lookup is what fails
    });
    expect(hello).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } });
    expect(await client.closed).toBe(1013);
  } finally {
    await server.app.close();
    await down.end();
  }
});

test('the OpenAPI document lists every API path', async () => {
  const pool = createPool('postgres://ts_rtc:ts_rtc@127.0.0.1:1/none'); // never queried
  const server = await serve(pool);
  try {
    const { body } = await server.call('GET', '/api/openapi.json');
    expect(Object.keys(body.paths as object).sort()).toEqual([
      '/api/auth/login',
      '/api/auth/register',
      '/api/rooms',
      '/api/rooms/{id}',
      '/api/rooms/{id}/members',
      '/api/rooms/{id}/members/{userId}',
    ]);
  } finally {
    await server.app.close();
    await pool.end();
  }
});
