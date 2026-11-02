import { useEffect, useRef, useState } from 'react';
import { useCall } from './useCall.js';
import { ConnectivityPanel } from './diagnostics/ConnectivityPanel.js';
import type { SelectedPath } from './diagnostics/ice.js';

function Video({ stream, muted = false }: { stream: MediaStream | null; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      style={{ width: '100%', aspectRatio: '16 / 9', background: '#111', borderRadius: 8 }}
    />
  );
}

function PathInfo({ path, state }: { path: SelectedPath | null | undefined; state: string }) {
  if (state === 'failed') {
    return (
      <div style={{ color: 'crimson' }}>ICE failed: no direct path. A relay (TURN) is needed.</div>
    );
  }
  if (!path) return null;
  return (
    <div data-testid="path" style={{ fontSize: 13, color: '#555' }}>
      {path.local} ⇄ {path.remote} over {path.protocol}
      {path.rttMs !== null && ` · RTT ${path.rttMs} ms`}
    </div>
  );
}

export function App() {
  const { connection, room, local, muted, mediaError, remotes, paths, join, toggle, leave } =
    useCall();
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<unknown>) {
    setError(null);
    action().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }

  const member = (id: string) => room?.members.find((m) => m.participantId === id);
  const { status, closeCode, closeReason } = connection;
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 960 }}>
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

      {status === 'ready' && !room && (
        <section>
          <input
            aria-label="Your name"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
          />{' '}
          <button disabled={!name.trim()} onClick={() => run(() => join(null, name))}>
            Create room
          </button>
          <p>
            <input
              aria-label="Room ID"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.trim())}
            />{' '}
            <button
              disabled={!name.trim() || !roomId}
              onClick={() => run(() => join(roomId, name))}
            >
              Join
            </button>
          </p>
          <ConnectivityPanel iceServers={connection.iceServers} />
        </section>
      )}

      {room && (
        <section>
          <p>
            Room <code data-testid="room-id">{room.roomId}</code>{' '}
            <button onClick={() => run(() => toggle('audio'))}>
              {muted.audioMuted ? 'Unmute' : 'Mute'}
            </button>{' '}
            <button onClick={() => run(() => toggle('video'))}>
              {muted.videoMuted ? 'Camera on' : 'Camera off'}
            </button>{' '}
            <button onClick={() => run(leave)}>Leave</button>
          </p>
          {mediaError && <p style={{ color: 'darkorange' }}>{mediaError}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            <figure style={{ margin: 0 }}>
              <Video stream={local} muted />
              <figcaption>{member(room.participantId)?.displayName} (you)</figcaption>
            </figure>
            {remotes.map((peer) => {
              const m = member(peer.participantId);
              return (
                <figure key={peer.participantId} style={{ margin: 0 }} data-testid="remote">
                  <Video stream={peer.stream} />
                  <figcaption>
                    {m?.displayName ?? 'unknown'}
                    {m?.audioMuted && <span data-testid="muted"> · muted</span>}
                    {m?.videoMuted && <span data-testid="camera-off"> · camera off</span>} ·{' '}
                    <span data-testid="peer-state">{peer.state}</span>
                    <PathInfo path={paths[peer.participantId]} state={peer.state} />
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}

      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </main>
  );
}
