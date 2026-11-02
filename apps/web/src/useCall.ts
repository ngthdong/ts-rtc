import type { RoomSnapshot } from '@ts-rtc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelectedPath } from './diagnostics/ice.js';
import { getLocalMedia, stopTracks } from './media/localMedia.js';
import { MeshCall, type RemotePeer } from './mesh/MeshCall.js';
import { RoomClient } from './room/RoomClient.js';
import { initialSnapshot, SignalingClient } from './signaling/SignalingClient.js';

declare global {
  interface Window {
    __tsRtc?: {
      inboundBytes(): Promise<Record<string, { audio: number; video: number }>>;
      paths(): Promise<Record<string, SelectedPath | null>>;
    };
  }
}

function signalingUrl(): string {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

// Signaling connection, room membership and the Mesh call, wired together for the UI.
export function useCall() {
  const [connection, setConnection] = useState(initialSnapshot);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<RemotePeer[]>([]);
  const [paths, setPaths] = useState<Record<string, SelectedPath | null>>({});
  const refs = useRef<{ client: SignalingClient; rooms: RoomClient } | null>(null);
  const call = useRef<{
    mesh: MeshCall;
    stream: MediaStream | null;
    poll: ReturnType<typeof setInterval>;
  } | null>(null);

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
      clearInterval(call.current?.poll);
      call.current?.mesh.close();
      stopTracks(call.current?.stream ?? null);
      call.current = null;
      client.close();
      refs.current = null;
    };
  }, []);

  const endCall = useCallback(() => {
    clearInterval(call.current?.poll);
    call.current?.mesh.close();
    stopTracks(call.current?.stream ?? null);
    call.current = null;
    setLocal(null);
    setRemotes([]);
    setPaths({});
  }, []);

  const join = useCallback(
    async (roomId: string | null, displayName: string) => {
      if (!refs.current) return;
      const { client, rooms } = refs.current;
      const target = roomId ?? (await rooms.create());
      const media = await getLocalMedia();
      setLocal(media.stream);
      setMediaError(media.error);
      const mesh = new MeshCall(client, media.stream, client.snapshot.iceServers);
      const poll = setInterval(() => {
        void mesh.paths().then(setPaths);
      }, 2_000);
      call.current = { mesh, stream: media.stream, poll };
      mesh.subscribe(() => {
        setRemotes(mesh.view);
      });
      if (import.meta.env.DEV) {
        window.__tsRtc = { inboundBytes: () => mesh.inboundBytes(), paths: () => mesh.paths() };
      }
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

  return { connection, room, local, mediaError, remotes, paths, join, leave };
}
