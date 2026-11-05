import fc from 'fast-check';
import { expect, test } from 'vitest';
import { backoffMs, RECONNECT, shouldReconnect } from './ReconnectPolicy.js';

const { baseMs, capMs, maxAttempts } = RECONNECT;

test('every delay is in [0, min(cap, base · 2^n)]', () => {
  fc.assert(
    fc.property(
      fc.nat(30),
      fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      (n, r) => {
        const delay = backoffMs(n, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(Math.min(capMs, baseMs * 2 ** n));
      },
    ),
  );
});

test('the worst case over all attempts is 45.5 s: past the server grace of 30 s', () => {
  const worst = Array.from({ length: maxAttempts }, (_, n) => backoffMs(n, () => 1));
  expect(worst).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  expect(worst.reduce((a, b) => a + b)).toBe(45_500);
});

test('deliberate, sign-in-again and replaced closes are final; drops are retried', () => {
  for (const code of [1000, 4400, 4401, 4409]) expect(shouldReconnect(code)).toBe(false);
  for (const code of [null, 1001, 1006, 1011, 1013, 4000, 4408]) {
    expect(shouldReconnect(code)).toBe(true);
  }
});
