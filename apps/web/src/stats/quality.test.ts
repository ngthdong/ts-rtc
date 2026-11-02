import { expect, test } from 'vitest';
import chromium from './fixtures/chromium.json' with { type: 'json' };
import firefox from './fixtures/firefox.json' with { type: 'json' };
import { computeQuality, toReport, type Stat } from './quality.js';

const toStats = (list: object[]) => new Map((list as Stat[]).map((s) => [s.id, s]));

test('Chromium (recorded): rates from deltas, path and RTT from the selected pair', () => {
  const q = computeQuality(toStats(chromium.after), toStats(chromium.before));
  // 2.04 s apart: ~25 kbps audio + ~276 kbps video each way, early in the call
  expect(q.inKbps).toBeCloseTo(301.7, 0);
  expect(q.outKbps).toBeCloseTo(302.4, 0);
  expect(q.lossPct).toBe(0);
  expect(q.jitterMs).toBe(2);
  expect(q.rttMs).toBe(1);
  expect(q.path).toMatchObject({ local: 'host', remote: 'host', protocol: 'udp' });
  expect(q.video).toMatchObject({ width: 480, height: 270 });
  expect(q.video?.fps).toBeGreaterThan(15);
  expect(q.limitation).toBe('bandwidth'); // the encoder is still ramping up
});

test('Firefox (shape): no transport stat, RTT from remote-inbound-rtp, no limitation', () => {
  const q = computeQuality(toStats(firefox.after), toStats(firefox.before));
  expect(q.inKbps).toBe(1040); // 8 × (10 000 + 250 000) bytes / 2 s
  expect(q.outKbps).toBe(1000);
  expect(q.lossPct).toBeCloseTo(100 / 101, 5); // worst stream: audio, 1 lost of 100 + 1
  expect(q.jitterMs).toBe(11);
  expect(q.rttMs).toBe(42);
  expect(q.path).toMatchObject({ local: 'srflx', remote: 'host' });
  expect(q.video).toEqual({ width: 640, height: 480, fps: 30 });
  expect(q.limitation).toBeNull();
});

test('first sample: no previous report, so no rates (cumulative counters are not rates)', () => {
  const q = computeQuality(toStats(chromium.after), undefined);
  expect(q.inKbps).toBeNull();
  expect(q.outKbps).toBeNull();
  expect(q.lossPct).toBeNull();
});

test('counter reset (new SSRC or a counter going down) never yields a negative rate', () => {
  const before = toStats(firefox.before);
  const after = toStats(
    firefox.after.map((s) =>
      s.type === 'inbound-rtp' && s.kind === 'audio'
        ? { ...s, bytesReceived: 100, packetsReceived: 2 } // restarted from zero
        : s.type === 'inbound-rtp'
          ? { ...s, id: 'new-ssrc' } // replaced stream: nothing to compare with
          : s,
    ),
  );
  const q = computeQuality(after, before);
  expect(q.inKbps).toBeNull();
  expect(q.lossPct).toBeNull();
});

test('the report carries candidate types and rounded numbers, never addresses', () => {
  const report = toReport('p2', computeQuality(toStats(firefox.after), toStats(firefox.before)));
  expect(report).toEqual({
    peer: 'p2',
    rttMs: 42,
    lossPct: 1,
    jitterMs: 11,
    inKbps: 1040,
    outKbps: 1000,
    pairLocal: 'srflx',
    pairRemote: 'host',
    protocol: 'udp',
    limitation: null,
  });
});
