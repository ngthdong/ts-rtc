import type { JoinResult } from '@ts-rtc/protocol';
import { describe, expect, test, vi } from 'vitest';
import {
  decide,
  RecoveryManager,
  type Facts,
  type Recovery,
  type RecoveryActions,
} from './RecoveryManager.js';

describe('decide', () => {
  const ok = { signalingReady: true, iceStuck: false };
  const rows: [string, Facts, Recovery][] = [
    ['resumed, nothing missing', { trouble: 'reconnected', ...ok }, 'none'],
    [
      'resumed, ICE stuck meanwhile',
      { trouble: 'reconnected', ...ok, iceStuck: true },
      'restart_ice',
    ],
    [
      'resume refused (grace over)',
      { trouble: 'reconnected', ...ok, resumeFailed: true },
      'rejoin',
    ],
    [
      'resumed, a transport is gone',
      { trouble: 'reconnected', ...ok, transportsMissing: true },
      'rebuild',
    ],
    ['resumed, a new Router', { trouble: 'reconnected', ...ok, routerChanged: true }, 'rebuild'],
    ['Worker died', { trouble: 'media_reset', ...ok }, 'rebuild'],
    ['server closed a transport', { trouble: 'transport_closed', ...ok }, 'rebuild'],
    ['ICE stuck, signaling up', { trouble: 'ice_stuck', ...ok, iceStuck: true }, 'restart_ice'],
    [
      'ICE stuck, signaling down',
      { trouble: 'ice_stuck', signalingReady: false, iceStuck: true },
      'wait',
    ],
  ];
  test.each(rows)('%s → %s', (_name, facts, expected) => {
    expect(decide(facts)).toBe(expected);
  });
});

const result = (extra: Partial<JoinResult> = {}): JoinResult => ({
  roomId: 'r',
  participantId: 'p',
  roomSeq: 1,
  mode: 'sfu',
  members: [],
  resumeToken: 'r.p.s',
  transportIds: ['t-send', 't-recv'],
  ...extra,
});

/** Every action recorded in `calls`, in order; healthy unless overridden. */
function setup(overrides: Partial<RecoveryActions> = {}) {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(() => {
      calls.push(name);
      return Promise.resolve();
    });
  const actions: RecoveryActions = {
    signalingReady: () => true,
    iceStuck: () => false,
    resume: vi.fn(() => {
      calls.push('resume');
      return Promise.resolve<JoinResult | null>(result());
    }),
    reconcile: step('reconcile'),
    transportsMissing: (alive) => !alive.includes('t-send'),
    routerChanged: () => false,
    restartIce: step('restartIce'),
    rebuild: step('rebuild'),
    rejoin: step('rejoin'),
    ...overrides,
  };
  return { manager: new RecoveryManager(actions), calls };
}

test('a resume that works reconciles the gap and changes nothing else', async () => {
  const { manager, calls } = setup();
  await manager.handle('reconnected');
  expect(calls).toEqual(['resume', 'reconcile']);
  expect(manager.log).toEqual(['none (reconnected)']);
});

test('a refused resume joins again, then rebuilds the media', async () => {
  const { manager, calls } = setup({
    resume: () => {
      calls.push('resume');
      return Promise.resolve(null);
    },
  });
  await manager.handle('reconnected');
  expect(calls).toEqual(['resume', 'rejoin', 'rebuild']);
  expect(manager.log).toEqual(['rejoin (reconnected)']);
});

test('a failed ICE restart falls back to a rebuild', async () => {
  const { manager, calls } = setup({
    iceStuck: () => true,
    restartIce: () => Promise.reject(new Error('NOT_FOUND: no such transport')),
  });
  await manager.handle('ice_stuck');
  expect(calls).toEqual(['rebuild']);
  expect(manager.log).toEqual(['restart_ice (ice_stuck)', 'rebuild (restart_ice failed)']);
});

test('troubles are handled one at a time, in order', async () => {
  let running = 0;
  let overlapped = false;
  const order: string[] = [];
  const slow = (name: string) => async () => {
    running += 1;
    if (running > 1) overlapped = true;
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`${name}:end`);
    running -= 1;
  };
  const { manager } = setup({ rebuild: slow('rebuild'), restartIce: slow('restartIce') });
  const done = [manager.handle('media_reset'), manager.handle('transport_closed')];
  await Promise.all(done);
  expect(overlapped).toBe(false);
  expect(order).toEqual(['rebuild:start', 'rebuild:end', 'rebuild:start', 'rebuild:end']);
  expect(manager.log).toEqual(['rebuild (media_reset)', 'rebuild (transport_closed)']);
});

test('a failing recovery is logged and does not stop the next one', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { manager, calls } = setup({ rebuild: () => Promise.reject(new Error('boom')) });
  await manager.handle('media_reset');
  await manager.handle('reconnected');
  expect(warn).toHaveBeenCalledWith('recovery: failed', 'media_reset', expect.any(Error));
  expect(calls).toEqual(['resume', 'reconcile']);
  warn.mockRestore();
});
