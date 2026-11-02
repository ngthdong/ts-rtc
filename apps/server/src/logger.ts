import { pino, type DestinationStream, type Logger } from 'pino';

/** Never written at any level: credentials, SDP (ICE passwords, addresses), raw candidates. */
const SECRET_KEYS = ['accessToken', 'password', 'credential', 'sdp', 'candidate'];
export const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

export interface LoggerOptions {
  level: string;
  env: string;
  version: string;
}

/** Base fields on every line: service, env, version (+ pino's level, time, msg). */
export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { service: 'ts-rtc-server', env: options.env, version: options.version },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    destination,
  );
}
