import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

test('uses defaults when nothing is set', () => {
  expect(loadConfig({})).toEqual({
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 4000,
    APP_VERSION: 'dev',
    LOG_LEVEL: 'info',
    MESH_MAX_PARTICIPANTS: 4,
    ALLOWED_ORIGINS: ['http://localhost:5173'],
    ICE_SERVERS: [],
    MEDIA_LISTEN_IP: '127.0.0.1',
    MEDIA_PORT_BASE: 40_000,
    TURN_URLS: [
      'stun:127.0.0.1:3478',
      'turn:127.0.0.1:3478?transport=udp',
      'turn:127.0.0.1:3478?transport=tcp',
    ],
    TURN_TTL_SECONDS: 14_400,
  });
});

test('rejects an invalid port', () => {
  expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid configuration/);
});

test('splits ALLOWED_ORIGINS on commas', () => {
  const config = loadConfig({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
  expect(config.ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
});

test('parses ICE_SERVERS as JSON and rejects anything else', () => {
  const servers = '[{"urls":"stun:stun.example.org:3478"}]';
  expect(loadConfig({ ICE_SERVERS: servers }).ICE_SERVERS).toEqual([
    { urls: 'stun:stun.example.org:3478' },
  ]);
  expect(() => loadConfig({ ICE_SERVERS: 'stun:x' })).toThrow(/Invalid configuration/);
  expect(() => loadConfig({ ICE_SERVERS: '[{"url":"stun:x"}]' })).toThrow(/Invalid configuration/);
});

test('a TURN secret must be long enough to resist guessing', () => {
  expect(() => loadConfig({ TURN_SECRET: 'short' })).toThrow(/Invalid configuration/);
  expect(loadConfig({ TURN_SECRET: 'x'.repeat(32) }).TURN_SECRET).toHaveLength(32);
});
