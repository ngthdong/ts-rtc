import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

test('uses defaults when nothing is set', () => {
  expect(loadConfig({})).toEqual({
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 4000,
    LOG_LEVEL: 'info',
    ALLOWED_ORIGINS: ['http://localhost:5173'],
    ICE_SERVERS: [],
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
