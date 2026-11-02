import { useEffect, useState } from 'react';
import { initialSnapshot, SignalingClient, type SignalingSnapshot } from './SignalingClient.js';

function signalingUrl(): string {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function useSignaling(): SignalingSnapshot {
  const [snapshot, setSnapshot] = useState(initialSnapshot);

  useEffect(() => {
    const client = new SignalingClient(signalingUrl());
    const unsubscribe = client.subscribe(() => {
      setSnapshot(client.snapshot);
    });
    return () => {
      unsubscribe();
      client.close();
    };
  }, []);

  return snapshot;
}
