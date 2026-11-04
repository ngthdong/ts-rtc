import { useEffect, useRef, useState } from 'react';
import { LoginPage } from './auth/LoginPage.js';
import { accessToken, api, signOut } from './auth/session.js';
import { useCall } from './useCall.js';
import { ConnectivityPanel } from './diagnostics/ConnectivityPanel.js';
import type { PeerQuality } from './stats/quality.js';

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

const show = (value: number | null, unit: string, digits = 0) =>
  value === null ? '–' : `${value.toFixed(digits)}${unit}`;

/** Per-tile quality overlay: the 2 s sample for this peer connection. */
function QualityInfo({ q, state }: { q: PeerQuality | undefined; state: string }) {
  if (state === 'failed') {
    return (
      <div style={{ color: 'crimson' }}>ICE failed: no direct path. A relay (TURN) is needed.</div>
    );
  }
  if (!q?.path) return null;
  const { path, video, limitation } = q;
  return (
    <div data-testid="quality" style={{ fontSize: 13, color: '#555' }}>
      <div data-testid="path">
        {path.local} ⇄ {path.remote} over {path.protocol} · RTT {show(q.rttMs, ' ms')}
      </div>
      <div>
        loss {show(q.lossPct, ' %', 1)} · jitter {show(q.jitterMs, ' ms')} · in{' '}
        {show(q.inKbps, ' kbps')} · out {show(q.outKbps, ' kbps')}
      </div>
      <div>
        {video ? `${video.width}×${video.height} @ ${show(video.fps, ' fps')}` : 'no video in'}
        {limitation && limitation !== 'none' && ` · my video limited by ${limitation}`}
      </div>
    </div>
  );
}

const PAGE = { fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 960 };

/** Signed out: the login page. Signed in: the call (a 401 or close 4401 signs out). */
export function App() {
  const [signedIn, setSignedIn] = useState(() => accessToken.get() !== null);
  useEffect(() => {
    const onSignedOut = () => {
      setSignedIn(false);
    };
    window.addEventListener('ts-rtc:signed-out', onSignedOut);
    return () => {
      window.removeEventListener('ts-rtc:signed-out', onSignedOut);
    };
  }, []);
  if (signedIn) return <Call />;
  return (
    <main style={PAGE}>
      <h1>ts-rtc</h1>
      <LoginPage
        onSignedIn={() => {
          setSignedIn(true);
        }}
      />
    </main>
  );
}

function Call() {
  const {
    connection,
    room,
    closedReason,
    local,
    muted,
    mediaError,
    remotes,
    quality,
    join,
    toggle,
    toggleScreen,
    sharing,
    leave,
  } = useCall();
  const [roomId, setRoomId] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  /** The room this tab created: its owner may add members. */
  const [ownRoomId, setOwnRoomId] = useState<string | null>(null);
  const [memberEmail, setMemberEmail] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<unknown>) {
    setError(null);
    action().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }

  const member = (id: string) => room?.members.find((m) => m.participantId === id);
  /** The dominant speaker's tile gets a border; nothing moves (no reordering, no resizing). */
  const speaking = (id: string) =>
    room?.activeSpeaker === id
      ? { 'data-speaking': true, style: { margin: 0, outline: '3px solid #2a7', borderRadius: 8 } }
      : {};
  const { status, closeCode, closeReason } = connection;
  return (
    <main style={PAGE}>
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
          {closedReason && (
            <p role="status" style={{ color: 'darkorange' }}>
              The server closed the room ({closedReason}). You can create or join another one.
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />{' '}
            Private
          </label>{' '}
          <button
            onClick={() =>
              run(async () => {
                setNotice(null);
                const created = await join(null, { visibility: isPrivate ? 'private' : 'public' });
                setOwnRoomId(created ?? null);
              })
            }
          >
            Create room
          </button>{' '}
          <button onClick={() => run(() => join(null, { mode: 'sfu', loopback: true }))}>
            SFU loopback test
          </button>{' '}
          <button onClick={signOut}>Sign out</button>
          <p>
            <input
              aria-label="Room ID"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.trim())}
            />{' '}
            <button disabled={!roomId} onClick={() => run(() => join(roomId))}>
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
            {room.mode === 'sfu' && (
              <>
                <button onClick={() => run(toggleScreen)}>
                  {sharing ? 'Stop sharing' : 'Share screen'}
                </button>{' '}
              </>
            )}
            <button onClick={() => run(leave)}>Leave</button>
          </p>
          {room.roomId === ownRoomId && (
            <p>
              <input
                aria-label="Member email"
                placeholder="Member email"
                type="email"
                value={memberEmail}
                onChange={(e) => setMemberEmail(e.target.value.trim())}
              />{' '}
              <button
                disabled={!memberEmail}
                onClick={() =>
                  run(async () => {
                    await api('POST', `/api/rooms/${room.roomId}/members`, { email: memberEmail });
                    setNotice(`${memberEmail} can join now`);
                    setMemberEmail('');
                  })
                }
              >
                Add member
              </button>
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {mediaError && <p style={{ color: 'darkorange' }}>{mediaError}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            <figure style={{ margin: 0 }} {...speaking(room.participantId)}>
              <Video stream={local} muted />
              <figcaption>{member(room.participantId)?.displayName} (you)</figcaption>
            </figure>
            {remotes.map((peer) => {
              const m = member(peer.participantId);
              if (peer.screen) {
                return (
                  <figure
                    key={`${peer.participantId}#screen`}
                    style={{ margin: 0, gridColumn: '1 / -1' }}
                    data-testid="screen"
                  >
                    <Video stream={peer.stream} muted />
                    <figcaption>{m?.displayName ?? 'Someone'} is sharing their screen</figcaption>
                  </figure>
                );
              }
              return (
                <figure
                  key={peer.participantId}
                  style={{ margin: 0 }}
                  {...speaking(peer.participantId)}
                  data-testid="remote"
                >
                  <Video stream={peer.stream} />
                  <figcaption>
                    {m?.displayName ?? 'unknown'}
                    {peer.participantId === room.participantId && ' (you, back from the SFU)'}
                    {m?.audioMuted && <span data-testid="muted"> · muted</span>}
                    {m?.videoMuted && <span data-testid="camera-off"> · camera off</span>} ·{' '}
                    <span data-testid="peer-state">{peer.state}</span>
                    <QualityInfo q={quality[peer.participantId]} state={peer.state} />
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
