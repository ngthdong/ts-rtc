import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SpeakerGate } from '../src/media/speaker-gate.js';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Feeds `changes` ([ms, participant]) to a gate and returns what it emitted, with times. */
function run(changes: [number, string][], until = 10_000): [number, string][] {
  const start = Date.now();
  const emitted: [number, string][] = [];
  const gate = new SpeakerGate((id) => emitted.push([Date.now() - start, id]));
  for (const [at, id] of changes) {
    vi.advanceTimersByTime(start + at - Date.now());
    gate.offer(id);
  }
  vi.advanceTimersByTime(start + until - Date.now());
  gate.close();
  return emitted;
}

test('the first speaker is emitted at once', () => {
  expect(run([[100, 'a']])).toEqual([[100, 'a']]);
});

test('a change within 1.5 s of the last one waits for the hold to end', () => {
  expect(
    run([
      [0, 'a'],
      [500, 'b'],
    ]),
  ).toEqual([
    [0, 'a'],
    [1_500, 'b'],
  ]);
});

test('flicker inside the hold collapses to the latest speaker, or to nothing', () => {
  expect(
    run([
      [0, 'a'],
      [200, 'b'],
      [400, 'c'],
      [600, 'b'],
    ]),
  ).toEqual([
    [0, 'a'],
    [1_500, 'b'],
  ]);
  expect(
    run([
      [0, 'a'],
      [200, 'b'],
      [400, 'a'],
    ]), // back to a before the hold ended: nothing changed for the UI
  ).toEqual([[0, 'a']]);
});

test('never more than one event per second, never two within 1.5 s', () => {
  // A dominance change every 100 ms for 10 s, alternating among four people.
  const changes: [number, string][] = Array.from({ length: 100 }, (_, i) => [
    i * 100,
    'abcd'[i % 4] ?? 'a',
  ]);
  const emitted = run(changes, 12_000);
  expect(emitted.length).toBeGreaterThan(5);
  for (let i = 1; i < emitted.length; i++) {
    const gap = (emitted[i]?.[0] ?? 0) - (emitted[i - 1]?.[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(1_500);
  }
});
