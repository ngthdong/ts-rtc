import type { MuteState, RoomMode, RoomSnapshot } from '@ts-rtc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocalMedia, getTrack, liveLocalTracks, stopTracks } from './media/localMedia.js';
import { MeshCall, type RemotePeer } from './mesh/MeshCall.js';
import { countOpenConnections } from './mesh/PeerSession.js';
import { RoomClient } from './room/RoomClient.js';
import { SfuSession } from './sfu/SfuSession.js';
import type { PeerQuality } from './stats/quality.js';
import { initialSnapshot, SignalingClient } from './signaling/SignalingClient.js';

declare global {
  interface Window {
    /** Dev/test-only hook used by the Playwright tests. */
    __tsRtc?: {
      inboundBytes(): Promise<Record<string, { audio: number; video: number }>>;
      /** The last 2 s quality sample per remote participant. */
      quality(): Record<string, PeerQuality>;
      /** Raw getStats() of the first peer: for recording test fixtures from any browser. */
      rawStats(): Promise<unknown[]>;
      /** Leak check: both must be 0 after leaving, and members − 1 / ≤ 2 during a call. */
      resources(): { openConnections: number; liveLocalTracks: number };
    };
  }
}

/** `?relay` forces every connection through TURN: the way to test TURN on one machine. */
export const relayOnly = new URLSearchParams(window.location.search).has('relay');

let currentMesh: MeshCall | null = null;
let currentSfu: { session: SfuSession; self: string } | null = null;
let latestQuality: Record<string, PeerQuality> = {};
if (import.meta.env.DEV) {
  window.__tsRtc = {
    inboundBytes: async () =>
      currentSfu
        ? { [currentSfu.self]: await currentSfu.session.inboundBytes() }
        : (currentMesh?.inboundBytes() ?? {}),
    quality: () => latestQuality,
    rawStats: () => currentMesh?.rawStats() ?? Promise.resolve([]),
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
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<RemotePeer[]>([]);
  const [quality, setQuality] = useState<Record<string, PeerQuality>>({});
  const refs = useRef<{ client: SignalingClient; rooms: RoomClient } | null>(null);
  const call = useRef<{
    mesh: MeshCall;
    sfu?: SfuSession;
    stream: MediaStream;
    poll: ReturnType<typeof setInterval>;
  } | null>(null);

  /** The one teardown path for the local side of a call. Idempotent. */
  const stopCall = useCallback(() => {
    clearInterval(call.current?.poll);
    call.current?.mesh.close();
    call.current?.sfu?.close();
    stopTracks(call.current?.stream ?? null);
    call.current = null;
    currentMesh = currentSfu = null;
    latestQuality = {};
  }, []);

  const endCall = useCallback(() => {
    stopCall();
    setLocal(null);
    setRemotes([]);
    setQuality({});
  }, [stopCall]);

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
        setClosedReason(rooms.closedReason);
        if (!rooms.view) endCall(); // left, or closed by the server
      }),
    ];
    return () => {
      for (const fn of unsubscribe) fn();
      stopCall();
      client.close();
      refs.current = null;
    };
  }, [stopCall, endCall]);

  /** Joins `roomId`, or a new room when it is null. Media is acquired before joining. */
  const join = useCallback(
    async (roomId: string | null, displayName: string, mode: RoomMode = 'mesh') => {
      if (!refs.current) return;
      const { client, rooms } = refs.current;
      const target = roomId ?? (await rooms.create(mode));
      const media = await getLocalMedia();
      setLocal(media.stream);
      setMediaError(media.error);
      const ice = (): {
        iceServers: RTCIceServer[];
        iceTransportPolicy: RTCIceTransportPolicy;
      } => ({
        iceServers: client.snapshot.iceServers,
        iceTransportPolicy: relayOnly ? 'relay' : 'all',
      });
      const mesh = new MeshCall(client, media.stream, ice);
      let ticks = 0;
      const poll = setInterval(() => {
        const sample = currentSfu
          ? currentSfu.session
              .sampleQuality()
              .then((q) => (q ? { [currentSfu?.self ?? '']: q } : {}))
          : mesh.sampleQuality();
        void sample.then((q) => {
          setQuality((latestQuality = q));
          if (!currentSfu && ++ticks % 5 === 0) mesh.reportQuality(); // every 10 s
        });
      }, 2_000);
      call.current = { mesh, stream: media.stream, poll };
      currentMesh = mesh;
      mesh.subscribe(() => {
        setRemotes(mesh.view);
      });
      try {
        await rooms.join(target, displayName);
        const view = rooms.view;
        if (view?.mode === 'mesh') mesh.start(view);
        if (view?.mode === 'sfu' && view.routerRtpCapabilities) {
          // Stage 10: the SFU path, tested with yourself (loopback). Others' media: Stage 11.
          let echo: MediaStream | null = null;
          const show = () => {
            const state = (call.current?.sfu?.states.recv ?? 'new') as RTCPeerConnectionState;
            setRemotes([{ participantId: view.participantId, stream: echo, state }]);
          };
          const sfu = await SfuSession.start(client, view.routerRtpCapabilities, ice(), show);
          if (call.current?.mesh !== mesh) return sfu.close(); // left meanwhile
          call.current.sfu = sfu;
          currentSfu = { session: sfu, self: view.participantId };
          echo = await sfu.loopback(media.stream.getTracks());
          show();
        }
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

  return {
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
    leave,
  };
}
