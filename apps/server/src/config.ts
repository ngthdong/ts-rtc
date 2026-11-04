import { IceServer } from '@ts-rtc/protocol';
import { z } from 'zod';

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    /** Written on every log line. The deploy sets it to the git SHA. */
    APP_VERSION: z.string().max(64).default('dev'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Mesh sends one stream per peer from every browser, so rooms stay small. */
    MESH_MAX_PARTICIPANTS: z.coerce.number().int().min(2).max(10).default(4),
    /** SFU rooms: every browser sends once, whatever the room size. */
    SFU_MAX_PARTICIPANTS: z.coerce.number().int().min(2).max(50).default(10),
    ALLOWED_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    ICE_SERVERS: z
      .string()
      .default('[]')
      .transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON array' });
          return z.NEVER;
        }
      })
      .pipe(z.array(IceServer)),
    /** mediasoup Workers (one CPU core each). Default: one per core, minus one for Node. */
    WORKERS: z.coerce.number().int().min(1).max(64).optional(),
    /** WebRtcServer listen address; 0.0.0.0 in containers, with MEDIA_ANNOUNCED_ADDRESS set. */
    MEDIA_LISTEN_IP: z.string().default('127.0.0.1'),
    /** The address clients reach the Workers at (public IP or hostname), when behind NAT. */
    MEDIA_ANNOUNCED_ADDRESS: z.string().optional(),
    /** Worker i listens on MEDIA_PORT_BASE + i, UDP and TCP. */
    MEDIA_PORT_BASE: z.coerce.number().int().min(1024).max(65000).default(40_000),
    /** Let a participant consume its own Producer (SFU loopback test). Default: not in production. */
    ALLOW_LOOPBACK: z.stringbool().optional(),
    TURN_SECRET: z.string().min(32).optional(),
    /** Postgres: accounts and durable rooms. The default is compose.yaml's (development only). */
    DATABASE_URL: z.string().default('postgres://ts_rtc:ts_rtc@127.0.0.1:5432/ts_rtc'),
    /** Signs access tokens (HS256): `openssl rand -hex 32`. Required in production. */
    JWT_SECRET: z.string().min(32).optional(),
    /** Sign-up and sign-in attempts per client IP and minute (also the burst allowed at once). */
    AUTH_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(10),
    TURN_URLS: z
      .string()
      .default(
        'stun:127.0.0.1:3478,turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp',
      )
      .transform((value) => value.split(',').map((url) => url.trim())),
    TURN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(4 * 3600),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.JWT_SECRET !== undefined, {
    path: ['JWT_SECRET'],
    message: 'required in production: a development default would let anyone mint tokens',
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = Env.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
