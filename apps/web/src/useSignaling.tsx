import type { DebugEchoReply, DebugEchoRequest } from '@ts-rtc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SignalingStatus = 'connecting' | 'open' | 'closed';

function signalingUrl(): string {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** One WebSocket per mounted component. No reconnect yet (Stage 15). */
export function useSignaling() {
  const [status, setStatus] = useState<SignalingStatus>('connecting');
  const [closeCode, setCloseCode] = useState<number | null>(null);
  const [lastReply, setLastReply] = useState<DebugEchoReply | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(signalingUrl());
    socketRef.current = ws;
    ws.onopen = () => {
      setStatus('open');
    };
    ws.onclose = (event) => {
      setStatus('closed');
      setCloseCode(event.code);
    };
    ws.onmessage = (event) => {
      setLastReply(JSON.parse(String(event.data)) as DebugEchoReply);
    };
    return () => {
      // Detach first so a deliberate close (unmount, StrictMode re-run) does not update state.
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.close(1000);
      socketRef.current = null;
    };
  }, []);

  const sendEcho = useCallback((payload: string) => {
    const request: DebugEchoRequest = { type: 'debug.echo', payload };
    socketRef.current?.send(JSON.stringify(request));
  }, []);

  return { status, closeCode, lastReply, sendEcho };
}
