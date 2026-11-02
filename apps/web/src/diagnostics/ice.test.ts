import { expect, test } from 'vitest';
import { parseCandidate, selectedPath } from './ice.js';

test('parses host, srflx and relay candidate lines', () => {
  expect(parseCandidate('candidate:1 1 udp 2122260223 3f1c2b9e.local 54400 typ host')).toEqual({
    type: 'host',
    protocol: 'udp',
    address: '3f1c2b9e.local',
    port: 54400,
  });
  expect(
    parseCandidate(
      'candidate:2 1 UDP 1686052607 203.0.113.7 61000 typ srflx raddr 10.0.0.5 rport 54400',
    ),
  ).toMatchObject({ type: 'srflx', protocol: 'udp', relatedAddress: '10.0.0.5' });
  expect(parseCandidate('a=candidate:3 1 tcp 41885439 198.51.100.2 443 typ relay')).toMatchObject({
    type: 'relay',
    protocol: 'tcp',
  });
  expect(parseCandidate('garbage')).toBeNull();
});

test('finds the selected pair through the transport stats', () => {
  const stats = new Map(
    [
      { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
      { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
      {
        id: 'P2',
        type: 'candidate-pair',
        localCandidateId: 'L2',
        remoteCandidateId: 'R2',
        currentRoundTripTime: 0.0123,
      },
      { id: 'L1', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
      { id: 'L2', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
      { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
      { id: 'R2', type: 'remote-candidate', candidateType: 'prflx' },
    ].map((s) => [s.id, s]),
  );
  expect(selectedPath(stats)).toEqual({
    local: 'srflx',
    remote: 'prflx',
    protocol: 'udp',
    rttMs: 12,
  });
  expect(selectedPath(new Map())).toBeNull();
});
