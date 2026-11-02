import { useState } from 'react';
import { gatherCandidates, type Candidate } from './ice.js';

// Lists the candidates this browser can offer with the server-provided ICE servers.
export function ConnectivityPanel({ iceServers }: { iceServers: RTCIceServer[] }) {
  const [result, setResult] = useState<{ candidates: Candidate[]; ms: number } | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      setResult(await gatherCandidates(iceServers));
    } finally {
      setRunning(false);
    }
  }

  const has = (type: string) => result?.candidates.some((c) => c.type === type) ?? false;
  return (
    <details style={{ marginTop: 24 }}>
      <summary>Connectivity diagnostics</summary>
      <p style={{ fontSize: 13 }}>
        ICE servers: {iceServers.length ? iceServers.map((s) => String(s.urls)).join(', ') : 'none'}{' '}
        <button disabled={running} onClick={() => void run()}>
          {running ? 'Gathering…' : 'Gather candidates'}
        </button>
      </p>
      {result && (
        <>
          <p style={{ fontSize: 13 }}>
            {result.candidates.length} candidates in {result.ms} ms.{' '}
            {!has('srflx') &&
              'No srflx candidate: no STUN server configured, or it is unreachable. '}
            {!has('relay') && 'No relay candidate: calls across strict NATs will fail.'}
          </p>
          <ul data-testid="candidates" style={{ fontSize: 13, fontFamily: 'monospace' }}>
            {result.candidates.map((c, i) => (
              <li key={i}>
                {c.type} {c.protocol} {c.address}:{c.port}
                {c.relatedAddress && ` (from ${c.relatedAddress})`}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
