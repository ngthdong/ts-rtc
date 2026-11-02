import type { RoomSnapshot } from '@ts-rtc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocalMedia, stopTracks } from './media/localMedia.js';
import { MeshCall, type RemotePeer } from './mesh/MeshCall.js';
import { RoomClient } from './room/RoomClient.js';
import { initialSnapshot, SignalingClient } from './signaling/SignalingClient.js';

declare global {
  interface Window {
    __tsRtc?: { inboundBytes(): Promise<Record<string, { audio: number; video: number }>> };
  }
}

function signalingUrl(): string {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function useCall() {
  const [connection, setConnection] = useState(initialSnapshot);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<RemotePeer[]>([]);
  const refs = useRef<{ client: SignalingClient; rooms: RoomClient } | null>(null);
  const call = useRef<{ mesh: MeshCall; stream: MediaStream | null } | null>(null);

  useEffect(() => {
    const client = new SignalingClient(signalingUrl());
    const rooms = new RoomClient(client);
    refs.current = { client, rooms };
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
      call.current?.mesh.close();
      stopTracks(call.current?.stream ?? null);
      call.current = null;
      client.close();
      refs.current = null;
    };
  }, []);

  const endCall = useCallback(() => {
    call.current?.mesh.close();
    stopTracks(call.current?.stream ?? null);
    call.current = null;
    setLocal(null);
    setRemotes([]);
  }, []);

  const join = useCallback(
    async (roomId: string | null, displayName: string) => {
      if (!refs.current) return;
      const { client, rooms } = refs.current;
      const target = roomId ?? (await rooms.create());
      const media = await getLocalMedia();
      setLocal(media.stream);
      setMediaError(media.error);
      const mesh = new MeshCall(client, media.stream);
      call.current = { mesh, stream: media.stream };
      mesh.subscribe(() => {
        setRemotes(mesh.view);
      });
      if (import.meta.env.DEV) window.__tsRtc = { inboundBytes: () => mesh.inboundBytes() };
      try {
        await rooms.join(target, displayName);
        if (rooms.view) mesh.start(rooms.view);
      } catch (err) {
        endCall();
        throw err;
      }
    },
    [endCall],
  );

  const leave = useCallback(async () => {
    endCall();
    await refs.current?.rooms.leave();
  }, [endCall]);

  return { connection, room, local, mediaError, remotes, join, leave };
}
