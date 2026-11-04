import { SignJWT } from 'jose';
import { expect, test } from 'vitest';
import { Tokens } from '../src/auth/tokens.js';

const options = { secret: 's'.repeat(32), issuer: 'ts-rtc', audience: 'ts-rtc', ttlSeconds: 60 };
const tokens = new Tokens(options);
const key = new TextEncoder().encode(options.secret);
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('a fresh token verifies to its user id', async () => {
  expect(await tokens.verify(await tokens.sign('u-1'))).toBe('u-1');
});

test.each([
  ['expired', () => new Tokens({ ...options, ttlSeconds: -10 }).sign('u-1')],
  ['for another audience', () => new Tokens({ ...options, audience: 'other' }).sign('u-1')],
  ['from another issuer', () => new Tokens({ ...options, issuer: 'other' }).sign('u-1')],
  ['signed with another key', () => new Tokens({ ...options, secret: 'x'.repeat(32) }).sign('u-1')],
  [
    'with a tampered payload',
    async () => {
      const [header, , signature] = (await tokens.sign('u-1')).split('.');
      return `${header ?? ''}.${b64({ sub: 'u-admin', iss: 'ts-rtc', aud: 'ts-rtc' })}.${signature ?? ''}`;
    },
  ],
  [
    'with alg: none',
    () => {
      const exp = Math.floor(Date.now() / 1000) + 60;
      return `${b64({ alg: 'none' })}.${b64({ sub: 'u-1', iss: 'ts-rtc', aud: 'ts-rtc', exp })}.`;
    },
  ],
  [
    'with alg: HS512 (not the pinned algorithm)',
    () =>
      new SignJWT()
        .setProtectedHeader({ alg: 'HS512' })
        .setSubject('u-1')
        .setIssuer('ts-rtc')
        .setAudience('ts-rtc')
        .setExpirationTime('1m')
        .sign(new Uint8Array([...key, ...key])),
  ],
  ['that is not a JWT', () => Promise.resolve('garbage')],
])('a token %s is rejected', async (_name, make) => {
  expect(await tokens.verify(await make())).toBeUndefined();
});
