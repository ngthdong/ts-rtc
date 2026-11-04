export interface Candidate {
  type: string; // host | srflx | prflx | relay
  protocol: string; // udp | tcp
  address: string; // an IP, or a random *.local mDNS name for host candidates
  port: number;
  relatedAddress?: string; // for srflx/relay: the base it was derived from
}

/** "candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 10.0.0.5 rport 5000 …" */
export function parseCandidate(line: string): Candidate | null {
  const parts = line
    .replace(/^(a=)?candidate:/, '')
    .trim()
    .split(/\s+/);
  const [, , protocol, , address, port, typ, type] = parts;
  if (typ !== 'typ' || !protocol || !address || !port || !type) return null;
  const raddr = parts.indexOf('raddr');
  const relatedAddress = raddr > 0 ? parts[raddr + 1] : undefined;
  return {
    type,
    protocol: protocol.toLowerCase(),
    address,
    port: Number(port),
    ...(relatedAddress ? { relatedAddress } : {}),
  };
}

export async function gatherCandidates(
  config: RTCConfiguration,
  timeoutMs = 10_000,
): Promise<{ candidates: Candidate[]; ms: number }> {
  const pc = new RTCPeerConnection(config);
  pc.createDataChannel('probe'); // an offer needs at least one m-line to gather for
  const candidates: Candidate[] = [];
  const startedAt = performance.now();
  const done = new Promise<void>((resolve) => {
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return resolve(); // null = gathering complete
      const parsed = parseCandidate(candidate.candidate);
      if (parsed) candidates.push(parsed);
    };
    setTimeout(resolve, timeoutMs);
  });
  await pc.setLocalDescription();
  await done;
  pc.close();
  return { candidates, ms: Math.round(performance.now() - startedAt) };
}

export interface SelectedPath {
  local: string;
  remote: string;
  protocol: string;
  /** This browser's port of the pair: the E2E bandwidth test polices that one connection. */
  localPort: number | null;
  rttMs: number | null;
}

type Stat = Record<string, unknown> & { id: string; type: string };

export function selectedPath(stats: {
  forEach(fn: (stat: Stat) => void): void;
}): SelectedPath | null {
  const byId = new Map<string, Stat>();
  stats.forEach((stat) => byId.set(stat.id, stat));
  const all = [...byId.values()];
  const transport = all.find((s) => s.type === 'transport');
  const pair =
    byId.get(String(transport?.selectedCandidatePairId)) ?? // Chromium, Safari
    all.find((s) => s.type === 'candidate-pair' && s.selected === true); // Firefox
  if (!pair) return null;
  const local = byId.get(String(pair.localCandidateId));
  const remote = byId.get(String(pair.remoteCandidateId));
  if (!local || !remote) return null;
  const rtt = pair.currentRoundTripTime;
  return {
    local: String(local.candidateType),
    remote: String(remote.candidateType),
    protocol: String(local.protocol),
    localPort: typeof local.port === 'number' ? local.port : null,
    rttMs: typeof rtt === 'number' ? Math.round(rtt * 1000) : null,
  };
}
