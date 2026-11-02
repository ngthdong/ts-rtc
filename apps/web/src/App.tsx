import { useSignaling } from './signaling/useSignaling.js';

export function App() {
  const { status, sessionId, rttMs, closeCode, closeReason } = useSignaling();

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>ts-rtc</h1>
      <p>
        Signaling: <strong data-testid="status">{status}</strong>
        {status === 'closed' && (
          <span data-testid="close-info">
            {' '}
            ({closeCode ?? 'no close frame'}
            {closeReason ? `, ${closeReason}` : ''})
          </span>
        )}
      </p>
      {sessionId && <p data-testid="session">Session {sessionId}</p>}
      {rttMs !== null && <p data-testid="rtt">Heartbeat RTT {rttMs} ms</p>}
    </main>
  );
}
