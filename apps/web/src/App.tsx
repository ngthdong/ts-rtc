import { useState } from 'react';
import { useSignaling } from './signaling/useSignaling.js';

export function App() {
  const { connection, room, createRoom, joinRoom, leaveRoom } = useSignaling();
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<unknown>) {
    setError(null);
    action().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }

  const { status, closeCode, closeReason } = connection;
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 480 }}>
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
          <p>
            <input
              aria-label="Your name"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
          </p>
          <p>
            <button disabled={!name.trim()} onClick={() => run(() => createRoom(name))}>
              Create room
            </button>
          </p>
          <p>
            <input
              aria-label="Room ID"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.trim())}
            />{' '}
            <button
              disabled={!name.trim() || !roomId}
              onClick={() => run(() => joinRoom(roomId, name))}
            >
              Join
            </button>
          </p>
        </section>
      )}

      {room && (
        <section>
          <p>
            Room <code data-testid="room-id">{room.roomId}</code>
          </p>
          <ul data-testid="members">
            {room.members.map((m) => (
              <li key={m.participantId}>
                {m.displayName}
                {m.participantId === room.participantId && ' (you)'}
              </li>
            ))}
          </ul>
          <button onClick={() => run(leaveRoom)}>Leave</button>
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
