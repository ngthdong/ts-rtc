import type { RoomSnapshot } from '@ts-rtc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomClient } from '../room/RoomClient.js';
import { initialSnapshot, SignalingClient } from './SignalingClient.js';

function signalingUrl(): string {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function useSignaling() {
  const [connection, setConnection] = useState(initialSnapshot);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const roomClient = useRef<RoomClient | null>(null);

  useEffect(() => {
    const client = new SignalingClient(signalingUrl());
    const rooms = new RoomClient(client);
    roomClient.current = rooms;
    const unsubscribe = [
      client.subscribe(() => {
        setConnection(client.snapshot);
      }),
      rooms.subscribe(() => {
        setRoom(rooms.view);
      }),
    ];
    return () => {
      for (const fn of unsubscribe) fn();
      client.close();
      roomClient.current = null;
    };
  }, []);

  const createRoom = useCallback(
    async (displayName: string) => roomClient.current?.create(displayName),
    [],
  );
  const joinRoom = useCallback(
    async (roomId: string, displayName: string) => roomClient.current?.join(roomId, displayName),
    [],
  );
  const leaveRoom = useCallback(async () => roomClient.current?.leave(), []);

  return { connection, room, createRoom, joinRoom, leaveRoom };
}
