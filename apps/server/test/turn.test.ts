import { expect, test } from 'vitest';
import { mintTurnCredentials } from '../src/turn/credentials.js';

const config = {
  secret: '0123456789abcdef0123456789abcdef',
  urls: ['turn:127.0.0.1:3478?transport=udp'],
  ttlSeconds: 3600,
};

test('matches an independently computed HMAC-SHA1 vector', () => {
  // username "1800003600:session-1", HMAC computed with Python's hmac module
  expect(mintTurnCredentials(config, 'session-1', 1_800_000_000_000)).toEqual({
    urls: ['turn:127.0.0.1:3478?transport=udp'],
    username: '1800003600:session-1',
    credential: 'DoVzV/ipIlPcChWFJgJ4pTzgfko=',
  });
});

test('the expiry is now + ttl, in whole seconds', () => {
  const { username } = mintTurnCredentials(config, 'x', 1_000_500);
  expect(username).toBe('4600:x'); // floor(1000.5) + 3600
});
