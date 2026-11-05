import { CloseCode, type MuteState, type RoomMode, type RoomSnapshot } from '@ts-rtc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { accessToken, api, signOut } from './auth/session.js';
import { getLocalMedia, getTrack, liveLocalTracks, stopTracks } from './media/localMedia.js';
import { MeshCall, type RemotePeer } from './mesh/MeshCall.js';
import { countOpenConnections } from './mesh/PeerSession.js';
import { RecoveryManager, type RecoveryActions } from './recovery/RecoveryManager.js';
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
      /** SFU: remote tracks shown in tiles; must be 2 × (members − 1), no orphans. */
      receivedTracks(): number;
      /** What the browser's own "Stop sharing" button does to the screen track. */
      endScreenTrack(): void;
      /** SFU: the camera's simulcast layers as sent, lowest first. */
      sendLayers(): Promise<{ rid: string; bytes: number; width: number | null }[]>;
      /** SFU: the width of the video each tile receives right now. */
      receivedWidths(): Promise<Record<string, number>>;
      /** Leak check: both must be 0 after leaving, and members − 1 / ≤ 2 during a call. */
      resources(): { openConnections: number; liveLocalTracks: number };
      /** Our participant id in the room, if in one: unchanged by a resume, new after a rejoin. */
      participantId(): string | null;
      /** The RecoveryManager's decisions so far in this call, e.g. ['none (reconnected)']. */
      recoveryLog(): string[];
      /** The signaling socket drops and the network stays away for `holdMs` (media is untouched). */
      dropSignaling(holdMs: number): void;
      /** SFU: ICE restart on both transports, as recovery does for a stuck one. */
      restartIce(): Promise<void>;
      /** SFU: our transport ids (to have the server close one). */
      transportIds(): string[];
      /** SFU: the Router our media is on (to find, and kill, its Worker). */
      routerId(): string | null;
      /** The current resume token and access token: to resume from another connection. */
      tokens(): { resumeToken: string | null; accessToken: string | null };
    };
  }
}

const params = new URLSearchParams(window.location.search);
/** `?relay` forces every connection through TURN: the way to test TURN on one machine. */
export const relayOnly = params.has('relay');
/** New rooms use the SFU; `?mode=mesh` keeps Mesh (benchmarks, comparison). */
export const defaultMode: RoomMode = params.get('mode') === 'mesh' ? 'mesh' : 'sfu';
/** `?simulcast=off`: one camera layer (benchmarks: simulcast on vs off). */
const simulcast = params.get('simulcast') !== 'off';

export interface JoinOptions {
  mode?: RoomMode; // for a new room
  visibility?: 'public' | 'private'; // for a new room: private ones admit added members only
  loopback?: boolean; // SFU diagnostics: also receive yourself back
}

let currentMesh: MeshCall | null = null;
let currentSfu: SfuSession | null = null;
let currentRecovery: RecoveryManager | null = null;
let currentConnection: { client: SignalingClient; rooms: RoomClient } | null = null;
let latestQuality: Record<string, PeerQuality> = {};
if (import.meta.env.DEV) {
  window.__tsRtc = {
    inboundBytes: () =>
      currentSfu?.inboundBytes() ?? currentMesh?.inboundBytes() ?? Promise.resolve({}),
    quality: () => latestQuality,
    rawStats: () => currentMesh?.rawStats() ?? Promise.resolve([]),
    endScreenTrack: () => currentSfu?.endScreenTrack(),
    sendLayers: () => currentSfu?.sendLayers() ?? Promise.resolve([]),
    receivedWidths: () => currentSfu?.receivedWidths() ?? Promise.resolve({}),
    receivedTracks: () =>
      [...(currentSfu?.streams.values() ?? [])].reduce((n, s) => n + s.getTracks().length, 0),
    resources: () => ({
      openConnections: countOpenConnections(),
      liveLocalTracks: liveLocalTracks(),
    }),
    participantId: () => currentConnection?.rooms.view?.participantId ?? null,
    recoveryLog: () => [...(currentRecovery?.log ?? [])],
    dropSignaling: (holdMs) => currentConnection?.client.drop(holdMs),
    restartIce: () => currentSfu?.restartIce() ?? Promise.resolve(),
    transportIds: () => currentSfu?.transportIds() ?? [],
    routerId: () => currentSfu?.routerId ?? null,
    tokens: () => ({
      resumeToken: currentConnection?.rooms.resumeToken ?? null,
      accessToken: accessToken.get(),
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

/** One call's local side; the media sessions are replaced when recovery rebuilds them. */
interface Call {
  mesh: MeshCall;
  sfu: SfuSession;
  sfuActive: boolean;
  loopback: boolean;
  stream: MediaStream;
  poll: ReturnType<typeof setInterval>;
  recovery: RecoveryManager;
}

/** What recovery may do to the call `get()` returns, while it is the current one (`live`). */
function recoveryActions(
  get: () => Call,
  live: () => boolean,
  { client, rooms }: { client: SignalingClient; rooms: RoomClient },
  fresh: { sfu: () => SfuSession; shown: () => void },
): RecoveryActions {
  const sfu = () => (get().sfuActive ? get().sfu : null);
  return {
    signalingReady: () => client.snapshot.status === 'ready',
    iceStuck: () => sfu()?.iceStuck ?? false,
    resume: () => rooms.resume(),
    async reconcile(result) {
      const call = get();
      if (!live()) return;
      if (call.sfuActive) await call.sfu.reconcile(result.producers ?? []);
      else call.mesh.reconcile(result);
    },
    transportsMissing: (alive) =>
      sfu()
        ?.transportIds()
        .some((id) => !alive.includes(id)) ?? false,
    routerChanged: (result) => sfu() !== null && !get().sfu.builtFor(result),
    restartIce: () => get().sfu.restartIce(),
    async rejoin() {
      const call = get();
      const roomId = rooms.view?.roomId;
      if (!live() || !roomId) return;
      if (!call.sfuActive) return rooms.expire(); // Mesh: the call ends
      try {
        // A new participant in the same room.
        await rooms.join(roomId);
      } catch (err) {
        rooms.abandon(`could not rejoin: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      const state = muteState(call.stream);
      if (state.audioMuted || state.videoMuted) await rooms.setMuted(state);
    },
    /** A clean slate: the server forgets our media, then everything is sent and received anew. */
    async rebuild() {
      const call = get();
      if (!live() || !call.sfuActive) return;
      const next = fresh.sfu(); // listening (and holding) before the old one goes
      call.sfu.close();
      call.sfu = currentSfu = next;
      await client.request('sfu.closeTransports', {}).catch(() => undefined);
      const view = await rooms.sync(); // the current Router and everyone's Producers
      fresh.shown();
      await next.start(view, call.stream.getTracks(), call.loopback);
      for (const kind of ['audio', 'video'] as const) {
        const off = call.stream.getTracks().some((t) => t.kind === kind && !t.enabled);
        if (off) await call.sfu.setPaused(kind, true);
      }
      fresh.shown();
    },
  };
}

/** Signaling connection, room membership and the call, wired together for the UI. */
export function useCall() {
  const [connection, setConnection] = useState(initialSnapshot);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState<MuteState>({ audioMuted: false, videoMuted: false });
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<RemotePeer[]>([]);
  const [quality, setQuality] = useState<Record<string, PeerQuality>>({});
  const [sharing, setSharing] = useState(false);
  const refs = useRef<{ client: SignalingClient; rooms: RoomClient } | null>(null);
  const call = useRef<Call | null>(null);

  /** The one teardown path for the local side of a call. Idempotent. */
  const stopCall = useCallback(() => {
    clearInterval(call.current?.poll);
    call.current?.mesh.close();
    call.current?.sfu.close();
    stopTracks(call.current?.stream ?? null);
    call.current = null;
    currentMesh = currentSfu = null;
    currentRecovery = null;
    latestQuality = {};
  }, []);

  /** SFU tiles: one per member (yourself too in loopback), with whatever we receive of them. */
  const showSfu = useCallback(() => {
    const current = call.current;
    const view = refs.current?.rooms.view;
    if (!current?.sfuActive || !view) return;
    const state = current.sfu.states.recv as RTCPeerConnectionState;
    const shown = view.members.filter(
      (m) => current.loopback || m.participantId !== view.participantId,
    );
    const { streams } = current.sfu;
    setRemotes(
      shown.flatMap(({ participantId }) => {
        const screen = streams.get(`${participantId}#screen`);
        const camera = { participantId, stream: streams.get(participantId) ?? null, state };
        return screen ? [{ participantId, stream: screen, state, screen: true }, camera] : [camera];
      }),
    );
    setSharing(current.sfu.sharing);
  }, []);

  const endCall = useCallback(() => {
    stopCall();
    setLocal(null);
    setRemotes([]);
    setQuality({});
  }, [stopCall]);

  useEffect(() => {
    const client = new SignalingClient(signalingUrl(), {
      accessToken: accessToken.get() ?? undefined,
    });
    const rooms = new RoomClient(client);
    refs.current = currentConnection = { client, rooms };
    let session: string | null = null;
    const unsubscribe = [
      client.subscribe(() => {
        setConnection(client.snapshot);
        const { status, closeCode, sessionId } = client.snapshot;
        // The token expired or was rejected: back to the login page.
        if (closeCode === CloseCode.Unauthenticated) signOut();
        // A new sessionId after a drop: a new socket, greeted. Get the membership back.
        if (sessionId && session && sessionId !== session) {
          void call.current?.recovery.handle('reconnected');
        }
        session = sessionId ?? session;
        // No more attempts: the call cannot be recovered from here.
        if (status === 'closed' && rooms.view) {
          rooms.abandon(
            closeCode === CloseCode.Replaced ? 'continued elsewhere' : 'connection lost',
          );
        }
      }),

      rooms.subscribe(() => {
        setRoom(rooms.view);
        setClosedReason(rooms.closedReason);
        if (rooms.view) {
          showSfu(); // members changed: SFU tiles follow the member list
        } else {
          endCall(); // left, or closed by the server
        }
      }),
    ];
    // Closing the tab or reloading is leaving (close 1000): no "reconnecting" tile for others.
    const goodbye = () => {
      client.close();
    };
    window.addEventListener('pagehide', goodbye);
    return () => {
      window.removeEventListener('pagehide', goodbye);
      for (const fn of unsubscribe) fn();
      stopCall();
      client.close();
      refs.current = currentConnection = null;
    };
  }, [stopCall, endCall, showSfu]);

  /** Joins `roomId`, or a new room when it is null. Media is acquired before joining. */
  const join = useCallback(
    async (roomId: string | null, options: JoinOptions = {}): Promise<string | undefined> => {
      if (!refs.current) return;
      const { client, rooms } = refs.current;
      // A new room is a durable one (POST /api/rooms), owned by this account.
      const target =
        roomId ??
        (
          await api<{ id: string }>('POST', '/api/rooms', {
            name: 'Call',
            visibility: options.visibility ?? 'public',
            mode: options.mode ?? defaultMode,
          })
        ).id;
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
      // Both listen from before the join (no early offer or newProducer is lost); the room's
      // mode decides which one starts. Recovery makes new ones the same way.
      const fresh = {
        mesh: () => {
          const mesh = new MeshCall(client, media.stream, ice);
          mesh.subscribe(() => {
            if (call.current?.mesh === mesh) setRemotes(mesh.view);
          });
          return mesh;
        },
        sfu: (): SfuSession =>
          new SfuSession(client, ice(), showSfu, simulcast, (trouble) => {
            void call.current?.recovery.handle(trouble);
          }),
        shown: showSfu,
      };
      const mesh = fresh.mesh();
      const sfu = fresh.sfu();
      let ticks = 0;
      const poll = setInterval(() => {
        const current = call.current;
        if (!current) return;
        const sample = current.sfuActive
          ? current.sfu
              .sampleQuality()
              .then((q): Record<string, PeerQuality> => (q ? { sfu: q } : {}))
          : current.mesh.sampleQuality();
        void sample.then((q) => {
          setQuality((latestQuality = q));
          if (!current.sfuActive && ++ticks % 5 === 0) current.mesh.reportQuality(); // every 10 s
        });
      }, 2_000);
      const loopback = options.loopback ?? false;
      const live = () => call.current === current;
      const current: Call = {
        mesh,
        sfu,
        sfuActive: false,
        loopback,
        stream: media.stream,
        poll,
        recovery: new RecoveryManager(recoveryActions(() => current, live, refs.current, fresh)),
      };
      call.current = current;
      currentRecovery = current.recovery;
      currentMesh = mesh;
      try {
        await rooms.join(target);
        const view = rooms.view;
        if (view?.mode === 'mesh') mesh.start(view);
        if (view?.mode === 'sfu') {
          current.sfuActive = true;
          currentSfu = sfu;
          showSfu();
          await sfu.start(view, media.stream.getTracks(), loopback);
        }
        const state = muteState(media.stream);
        setMuted(state);
        if (state.audioMuted || state.videoMuted) await rooms.setMuted(state);
        return target;
      } catch (err) {
        endCall();
        throw err;
      }
    },
    [endCall, showSfu],
  );

  /**
   * Mute/unmute keeps the track (and the m-line) and sends silence or black frames; in SFU
   * rooms the Producer is also paused on the server. A device the call started without is
   * acquired now: Mesh adds it to every peer (renegotiation), SFU produces it.
   */
  const toggle = useCallback(async (kind: 'audio' | 'video') => {
    const current = call.current;
    if (!current || !refs.current) return;
    const track = current.stream.getTracks().find((t) => t.kind === kind);
    if (track) {
      track.enabled = !track.enabled;
      if (current.sfuActive) await current.sfu.setPaused(kind, !track.enabled);
    } else {
      const added = await getTrack(kind);
      if (current.sfuActive) {
        current.stream.addTrack(added);
        await current.sfu.produce(added);
      } else {
        current.mesh.addLocalTrack(added);
      }
    }
    const state = muteState(current.stream);
    setMuted(state);
    await refs.current.rooms.setMuted(state);
  }, []);

  /** SFU rooms: share the screen, or stop. Denial or cancel throws; no server call is made. */
  const toggleScreen = useCallback(async () => {
    const current = call.current;
    if (!current?.sfuActive) return;
    if (current.sfu.sharing) return current.sfu.stopScreen();
    try {
      await current.sfu.shareScreen();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        throw new Error('Screen sharing was cancelled or not allowed.', { cause: err });
      }
      const sharer = /already sharing: (\S+)/.exec(String(err))?.[1];
      const name = refs.current?.rooms.view?.members.find((m) => m.participantId === sharer);
      if (!sharer) throw err;
      throw new Error(`${name?.displayName ?? 'Someone'} is already sharing.`, { cause: err });
    }
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
    toggleScreen,
    sharing,
    leave,
  };
}
