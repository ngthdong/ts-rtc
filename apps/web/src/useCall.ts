import type { MuteState, RoomSnapshot } from '@ts-rtc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelectedPath } from './diagnostics/ice.js';
import { getLocalMedia, getTrack, liveLocalTracks, stopTracks } from './media/localMedia.js';
import { MeshCall, type RemotePeer } from './mesh/MeshCall.js';
import { countOpenConnections } from './mesh/PeerSession.js';
import { RoomClient } from './room/RoomClient.js';
import { initialSnapshot, SignalingClient } from './signaling/SignalingClient.js';

declare global {
  interface Window {
    /** Dev/test-only hook used by the Playwright tests. */
    __tsRtc?: {
      inboundBytes(): Promise<Record<string, { audio: number; video: number }>>;
      paths(): Promise<Record<string, SelectedPath | null>>;
      /** Leak check: both must be 0 after leaving, and members − 1 / ≤ 2 during a call. */
      resources(): { openConnections: number; liveLocalTracks: number };
    };
  }
}

/** `?relay` forces every connection through TURN: the way to test TURN on one machine. */
export const relayOnly = new URLSearchParams(window.location.search).has('relay');

let currentMesh: MeshCall | null = null;
if (import.meta.env.DEV) {
  window.__tsRtc = {
    inboundBytes: () => currentMesh?.inboundBytes() ?? Promise.resolve({}),
    paths: () => currentMesh?.paths() ?? Promise.resolve({}),
    resources: () => ({
      openConnections: countOpenConnections(),
      liveLocalTracks: liveLocalTracks(),
    }),
  };
}

function signalingUrl(): string {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** A kind counts as muted when there is no enabled track of it (absent or switched off). */
function muteState(stream: MediaStream): MuteState {
  const on = (kind: string) => stream.getTracks().some((t) => t.kind === kind && t.enabled);
  return { audioMuted: !on('audio'), videoMuted: !on('video') };
}

/** Signaling connection, room membership and the Mesh call, wired together for the UI. */
export function useCall() {
  const [connection, setConnection] = useState(initialSnapshot);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState<MuteState>({ audioMuted: false, videoMuted: false });
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<RemotePeer[]>([]);
  const [paths, setPaths] = useState<Record<string, SelectedPath | null>>({});
  const refs = useRef<{ client: SignalingClient; rooms: RoomClient } | null>(null);
  const call = useRef<{
    mesh: MeshCall;
    stream: MediaStream;
    poll: ReturnType<typeof setInterval>;
  } | null>(null);

  /** The one teardown path for the local side of a call. Idempotent. */
  const stopCall = useCallback(() => {
    clearInterval(call.current?.poll);
    call.current?.mesh.close();
    stopTracks(call.current?.stream ?? null);
    call.current = null;
    currentMesh = null;
  }, []);

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
      stopCall();
      client.close();
      refs.current = null;
    };
  }, [stopCall]);

  const endCall = useCallback(() => {
    stopCall();
    setLocal(null);
    setRemotes([]);
    setPaths({});
  }, [stopCall]);

  /** Joins `roomId`, or a new room when it is null. Media is acquired before joining. */
  const join = useCallback(
    async (roomId: string | null, displayName: string) => {
      if (!refs.current) return;
      const { client, rooms } = refs.current;
      const target = roomId ?? (await rooms.create());
      const media = await getLocalMedia();
      setLocal(media.stream);
      setMediaError(media.error);
      const mesh = new MeshCall(client, media.stream, () => ({
        iceServers: client.snapshot.iceServers,
        iceTransportPolicy: relayOnly ? 'relay' : 'all',
      }));
      const poll = setInterval(() => {
        void mesh.paths().then(setPaths);
      }, 2_000);
      call.current = { mesh, stream: media.stream, poll };
      currentMesh = mesh;
      mesh.subscribe(() => {
        setRemotes(mesh.view);
      });
      try {
        await rooms.join(target, displayName);
        if (rooms.view) mesh.start(rooms.view);
        const state = muteState(media.stream);
        setMuted(state);
        if (state.audioMuted || state.videoMuted) await rooms.setMuted(state);
      } catch (err) {
        endCall();
        throw err;
      }
    },
    [endCall],
  );

  /**
   * Mute/unmute keeps the track (and the m-line) and sends silence or black frames. A device
   * the call started without is acquired now and added to every peer (renegotiation).
   */
  const toggle = useCallback(async (kind: 'audio' | 'video') => {
    const current = call.current;
    if (!current || !refs.current) return;
    const track = current.stream.getTracks().find((t) => t.kind === kind);
    if (track) track.enabled = !track.enabled;
    else current.mesh.addLocalTrack(await getTrack(kind));
    const state = muteState(current.stream);
    setMuted(state);
    await refs.current.rooms.setMuted(state);
  }, []);

  const leave = useCallback(async () => {
    endCall();
    await refs.current?.rooms.leave();
  }, [endCall]);

  return { connection, room, local, muted, mediaError, remotes, paths, join, toggle, leave };
}
