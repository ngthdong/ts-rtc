import { createHmac } from 'node:crypto';
import type { IceServer } from '@ts-rtc/protocol';

export interface TurnConfig {
  secret: string;
  urls: string[];
  ttlSeconds: number;
}

/**
 * Time-limited TURN credentials, the "TURN REST API" scheme coturn checks with use-auth-secret:
 * username = "<expiry unix seconds>:<userKey>", credential = base64(HMAC-SHA1(secret, username)).
 * coturn recomputes the HMAC and refuses the username once its expiry has passed, so the
 * secret never leaves the server and a leaked credential dies on its own.
 */
export function mintTurnCredentials(
  config: TurnConfig,
  userKey: string,
  nowMs = Date.now(),
): IceServer {
  const expiry = Math.floor(nowMs / 1000) + config.ttlSeconds;
  const username = `${String(expiry)}:${userKey}`;
  const credential = createHmac('sha1', config.secret).update(username).digest('base64');
  return { urls: config.urls, username, credential };
}
