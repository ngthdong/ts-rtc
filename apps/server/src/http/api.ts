import { RoomMode, SignalingError, type ErrorCode } from '@ts-rtc/protocol';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifyNobody, hashPassword, verifyPassword } from '../auth/passwords.js';
import { authorize, type RoomAction } from '../auth/policy.js';
import type { Tokens } from '../auth/tokens.js';
import type { Db } from '../db/pool.js';
import * as rooms from '../db/rooms.js';
import { createUser, findUserByEmail } from '../db/users.js';
import type { RateLimiter } from './rate-limit.js';

export interface ApiDeps {
  db: Db;
  tokens: Tokens;
  /** Login and register, per client IP. */
  limiter: RateLimiter;
  /** Ends the live call of a deleted room (`room.closed {reason: 'deleted'}`). */
  closeLiveRoom: (roomId: string) => Promise<void>;
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_PAYLOAD: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

const Email = z.email().max(254);
const Credentials = z.object({ email: Email, password: z.string().min(1).max(128) });
const RoomInput = z.object({
  name: z.string().trim().min(1).max(80),
  visibility: z.enum(['public', 'private']).default('public'),
  mode: RoomMode.default('sfu'),
  maxParticipants: z.number().int().min(2).max(10).default(10),
});
const RoomId = z.object({ id: z.uuid() });
const Registration = z.object({
  email: Email,
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(40),
});

/** The HTTP API: accounts and durable rooms. Errors use the signaling error body and codes. */
export function registerApi(http: FastifyInstance, deps: ApiDeps): void {
  const { db, tokens } = deps;
  const app = http.withTypeProvider<ZodTypeProvider>();
  const limited = {
    onRequest: (req: FastifyRequest, _reply: unknown, done: (err?: Error) => void) => {
      try {
        deps.limiter.take(req.ip);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  };

  /** The caller's user id from `Authorization: Bearer <token>`. */
  async function caller(req: FastifyRequest): Promise<string> {
    const header = req.headers.authorization;
    const userId = header?.startsWith('Bearer ') ? await tokens.verify(header.slice(7)) : undefined;
    if (!userId) throw new SignalingError('UNAUTHENTICATED', 'sign in first');
    return userId;
  }
  /** The room, if `userId` may do `action` to it (owner actions). */
  async function ownRoom(req: FastifyRequest, roomId: string, action: RoomAction) {
    const userId = await caller(req);
    const room = await rooms.roomAccess(db, roomId, userId);
    if (!room) throw new SignalingError('NOT_FOUND', 'room not found');
    authorize(req.log, { userId }, action, room);
    return room;
  }

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const body = (code: ErrorCode, message: string, retryable = false) => ({
      error: { code, message, retryable },
    });
    if (err instanceof SignalingError) {
      return reply.code(STATUS[err.code] ?? 500).send(body(err.code, err.message, err.retryable));
    }
    if (hasZodFastifySchemaValidationErrors(err) || (err.statusCode ?? 500) < 500) {
      return reply.code(400).send(body('INVALID_PAYLOAD', err.message));
    }
    req.log.error({ err }, 'http.failed');
    return reply.code(500).send(body('INTERNAL', 'internal error'));
  });

  app.post(
    '/api/auth/register',
    { ...limited, schema: { body: Registration } },
    async (req, reply) => {
      const { password, ...rest } = req.body;
      const user = await createUser(db, { ...rest, passwordHash: await hashPassword(password) });
      if (!user) throw new SignalingError('CONFLICT', 'this email is already registered');
      return reply.code(201).send(user);
    },
  );

  app.post('/api/auth/login', { ...limited, schema: { body: Credentials } }, async (req) => {
    const { email, password } = req.body;
    const user = await findUserByEmail(db, email);
    const ok = user
      ? await verifyPassword(user.passwordHash, password)
      : await verifyNobody(password);
    if (!user || !ok) {
      req.log.info({ reason: 'bad_credentials' }, 'auth.login_failed');
      throw new SignalingError('UNAUTHENTICATED', 'wrong email or password');
    }
    return { accessToken: await tokens.sign(user.id) };
  });

  app.post('/api/rooms', { schema: { body: RoomInput } }, async (req, reply) =>
    reply.code(201).send(await rooms.createRoom(db, await caller(req), req.body)),
  );

  app.get('/api/rooms', async (req) => rooms.listRooms(db, await caller(req)));

  app.delete('/api/rooms/:id', { schema: { params: RoomId } }, async (req, reply) => {
    await ownRoom(req, req.params.id, 'room.delete');
    await rooms.deleteRoom(db, req.params.id);
    await deps.closeLiveRoom(req.params.id);
    return reply.code(204).send();
  });

  app.post(
    '/api/rooms/:id/members',
    { schema: { params: RoomId, body: z.object({ email: Email }) } },
    async (req, reply) => {
      await ownRoom(req, req.params.id, 'room.addMember');
      const user = await findUserByEmail(db, req.body.email);
      if (!user) throw new SignalingError('NOT_FOUND', 'no account with this email');
      await rooms.addMember(db, req.params.id, user.id);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/rooms/:id/members/:userId',
    { schema: { params: RoomId.extend({ userId: z.uuid() }) } },
    async (req, reply) => {
      await ownRoom(req, req.params.id, 'room.removeMember');
      await rooms.removeMember(db, req.params.id, req.params.userId);
      return reply.code(204).send(); // takes effect at that user's next join
    },
  );
}
