import { useState, type SubmitEvent } from 'react';
import { useSignaling } from './useSignaling.js';

export function App() {
  const { status, closeCode, lastReply, sendEcho } = useSignaling();
  const [text, setText] = useState('hello');

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    sendEcho(text);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>ts-rtc</h1>
      <p>
        Signaling: <strong data-testid="status">{status}</strong>
        {closeCode !== null && <> (close code {closeCode})</>}
      </p>
      <form onSubmit={onSubmit}>
        <input
          aria-label="Echo text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
        />
        <button type="submit" disabled={status !== 'open'}>
          Echo
        </button>
      </form>
      {lastReply && (
        <p data-testid="reply">
          {lastReply.payload} — session {lastReply.sessionId}
        </p>
      )}
    </main>
  );
}
