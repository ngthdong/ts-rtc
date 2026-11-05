import {
  SignalingError,
  type ClientReport,
  type MeshSignal,
  type RoomSnapshot,
} from '@ts-rtc/protocol';
import type { SignalingClient } from '../signaling/SignalingClient.js';
import { StatsCollector, toReport, type PeerQuality } from '../stats/quality.js';
import { PeerSession } from './PeerSession.js';

export interface RemotePeer {
  participantId: string;
  stream: MediaStream | null;
  state: RTCPeerConnectionState;
  /** A screen share (SFU): its own, larger tile. */
  screen?: boolean;
}

/**
 * A Mesh call: one PeerSession per other member. The newcomer offers to everyone in its join
 * snapshot; existing members answer when the offer arrives. Created before room.join so no
 * early offer is lost; signals are held until start() gives it the snapshot.
 */
export class MeshCall {
  private self: string | null = null;
  private held: { from: string; signal: MeshSignal }[] = [];
  private readonly peers = new Map<string, PeerSession>();
  private readonly remotes = new Map<string, RemotePeer>();
  private readonly listeners = new Set<() => void>();
  private readonly stats = new StatsCollector();
  /** The last sample, for the UI and tests (reading it does not disturb the deltas). */
  latestQuality: Record<string, PeerQuality> = {};
  private readonly unsubscribe: () => void;

  constructor(
    private readonly signaling: Pick<SignalingClient, 'request' | 'onEvent'>,
    private readonly localStream: MediaStream,
    /** Read per connection, so a peer that joins later gets the current ICE servers. */
    private readonly rtcConfig: () => RTCConfiguration,
  ) {
    this.unsubscribe = signaling.onEvent((event) => {
      if (event.type === 'mesh.signal') this.onSignal(event.payload.from, event.payload.signal);
      if (event.type === 'participant.left') this.hangUp(event.payload.participantId);
    });
  }

  /** Samples every connection (call every 2 s); quality is computed against the last sample. */
  async sampleQuality(): Promise<Record<string, PeerQuality>> {
    const connections = new Map([...this.peers].map(([id, peer]) => [id, peer.pc]));
    // Every connection sampled has an entry (Partial only because keys are open-ended).
    this.latestQuality = (await this.stats.sample(connections)) as Record<string, PeerQuality>;
    return this.latestQuality;
  }

  /** Dev/test hook: the raw report of the first peer connection, to record fixtures. */
  async rawStats(): Promise<unknown[]> {
    const first = this.peers.values().next();
    if (first.done) return [];
    const stats: unknown[] = [];
    (await first.value.pc.getStats()).forEach((stat: unknown) => stats.push(stat));
    return stats;
  }

  /** Sends the last sample to the server log (call every 10 s). */
  reportQuality(): void {
    const peers = Object.entries(this.latestQuality).map(([id, q]) => toReport(id, q));
    if (peers.length > 0) this.report({ kind: 'quality', peers });
  }

  /** Telemetry is best effort: a rate-limited or failed report is simply dropped. */
  private report(report: ClientReport): void {
    this.signaling.request('client.report', report).catch(() => undefined);
  }

  get view(): RemotePeer[] {
    return [...this.remotes.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(snapshot: RoomSnapshot): void {
    this.self = snapshot.participantId;
    for (const member of snapshot.members) {
      if (member.participantId !== this.self) this.connect(member.participantId);
    }
    const held = this.held;
    this.held = [];
    for (const { from, signal } of held) this.onSignal(from, signal);
  }

  /**
   * After a resume: hang up on members who left while we were away. Members who joined meanwhile
   * call us: their offers were held by the server and arrive with the resume.
   */
  reconcile(snapshot: RoomSnapshot): void {
    const present = new Set(snapshot.members.map((m) => m.participantId));
    for (const id of [...this.peers.keys()]) if (!present.has(id)) this.hangUp(id);
  }

  close(): void {
    this.unsubscribe();
    for (const id of [...this.peers.keys()]) this.hangUp(id);
    this.listeners.clear();
  }

  /** A device turned on mid-call goes to every peer; each connection renegotiates. */
  addLocalTrack(track: MediaStreamTrack): void {
    this.localStream.addTrack(track);
    for (const peer of this.peers.values()) peer.addTrack(track);
  }

  // Inbound RTP bytes per remote participant and kind.
  async inboundBytes(): Promise<Record<string, { audio: number; video: number }>> {
    const result: Record<string, { audio: number; video: number }> = {};
    for (const [id, peer] of this.peers) {
      const totals = { audio: 0, video: 0 };
      (await peer.pc.getStats()).forEach(
        (report: { type: string; kind?: string; bytesReceived?: number }) => {
          if (
            report.type === 'inbound-rtp' &&
            (report.kind === 'audio' || report.kind === 'video')
          ) {
            totals[report.kind] += report.bytesReceived ?? 0;
          }
        },
      );
      result[id] = totals;
    }
    return result;
  }

  private onSignal(from: string, signal: MeshSignal): void {
    if (!this.self) {
      this.held.push({ from, signal });
      return;
    }
    let peer = this.peers.get(from);
    if (!peer) {
      const isOffer = 'description' in signal && signal.description.type === 'offer';
      if (!isOffer) return; // a late message for a peer that already left
      peer = this.connect(from);
    }
    void peer.handle(signal);
  }

  private connect(remoteId: string): PeerSession {
    const peer = new PeerSession({
      polite: (this.self ?? '') < remoteId,
      localStream: this.localStream,
      send: (signal) => {
        this.signaling.request('mesh.signal', { to: remoteId, signal }).catch((err: unknown) => {
          // NOT_FOUND: the peer left while candidates were still trickling. Expected.
          if (!(err instanceof SignalingError && err.code === 'NOT_FOUND')) {
            console.warn('mesh: signal not delivered', err);
          }
        });
      },
      onChange: (stream, state) => {
        if (this.remotes.get(remoteId)?.state !== state) {
          this.report({ kind: 'state', peer: remoteId, state });
        }
        this.remotes.set(remoteId, { participantId: remoteId, stream, state });
        this.notify();
      },
      config: this.rtcConfig(),
    });
    this.peers.set(remoteId, peer);
    this.remotes.set(remoteId, { participantId: remoteId, stream: null, state: 'new' });
    this.notify();
    return peer;
  }

  private hangUp(remoteId: string): void {
    this.peers.get(remoteId)?.close();
    this.peers.delete(remoteId);
    if (this.remotes.delete(remoteId)) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
