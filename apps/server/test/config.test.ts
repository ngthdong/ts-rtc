import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

test('uses defaults when nothing is set', () => {
  expect(loadConfig({})).toEqual({
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 4000,
    LOG_LEVEL: 'info',
  });
});

test('rejects an invalid port', () => {
  expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid configuration/);
});
