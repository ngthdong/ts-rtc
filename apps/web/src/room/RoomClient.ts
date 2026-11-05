import {
  SignalingError,
  type JoinResult,
  type MuteState,
  type RoomSnapshot,
  type SignalingEvent,
} from '@ts-rtc/protocol';
import type { SignalingClient } from '../signaling/SignalingClient.js';

export class RoomClient {
  private current: RoomSnapshot | null = null;
  /** From the last join or resume; used once (the server keeps only the newest). */
  private token: string | null = null;
  /** Why the server ended the room under us, if it did; cleared by the next join. */
  closedReason: string | null = null;
  private held: SignalingEvent[] | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly signaling: Pick<SignalingClient, 'request' | 'onEvent'>) {
    signaling.onEvent((event) => {
      if (this.held) this.held.push(event);
      else this.apply(event);
    });
  }

  get view(): RoomSnapshot | null {
    return this.current;
  }

  /** Dev/test hook only: another connection resuming with it replaces this one (4409). */
  get resumeToken(): string | null {
    return this.token;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Joins with the account's display name (rooms are created over HTTP, POST /api/rooms). */
  async join(roomId: string): Promise<void> {
    this.closedReason = null;
    await this.bind(() => this.signaling.request('room.join', { roomId }));
  }

  /**
   * After a reconnect: the same membership, as of now (events sent while we were away are
   * lost; the snapshot replaces them). null: the server no longer has it (grace over).
   */
  async resume(): Promise<JoinResult | null> {
    const resumeToken = this.token;
    if (!resumeToken || !this.current) return null;
    this.token = null; // used once: the answer carries the next one
    try {
      return await this.bind(() => this.signaling.request('room.resume', { resumeToken }));
    } catch (err) {
      if (!(err instanceof SignalingError && err.code === 'NOT_FOUND')) throw err;
      return null;
    }
  }

  /** The current snapshot from the server (after a roomSeq gap, or to rebuild media). */
  async sync(): Promise<RoomSnapshot> {
    const snapshot = await this.signaling.request('room.sync', {});
    this.set(snapshot);
    return snapshot;
  }

  /** Mesh, after the grace: the membership is gone and the call ends (no rebuild in Mesh). */
  expire(): void {
    this.abandon('session expired');
  }

  /** Recovery gave up (or another tab took over): the call ends here and says why. */
  abandon(reason: string): void {
    this.token = null;
    this.closedReason = reason;
    this.set(null);
  }

  async leave(): Promise<void> {
    this.token = null;
    await this.signaling.request('room.leave', {});
    this.set(null);
  }

  async setMuted(state: MuteState): Promise<void> {
    await this.signaling.request('participant.update', state);
  }

  /** Join and resume: events racing ahead of the response are held, then replayed on top. */
  private async bind(request: () => Promise<JoinResult>): Promise<JoinResult> {
    this.held = []; // before the request is sent
    try {
      const result = await request();
      // The view is the snapshot alone: the token is not UI state, transportIds are recovery's.
      const snapshot: RoomSnapshot & Partial<JoinResult> = { ...result };
      this.token = result.resumeToken;
      delete snapshot.resumeToken;
      delete snapshot.transportIds;
      this.set(snapshot);
      for (const event of this.held) this.apply(event);
      return result;
    } finally {
      this.held = null;
    }
  }

  private apply(event: SignalingEvent): void {
    if (event.type === 'room.closed') {
      this.token = null;
      this.closedReason = event.payload.reason;
      this.set(null);
      return;
    }
    if (!('roomSeq' in event.payload)) return; // media events: MeshCall's and SfuSession's
    const view = this.current;
    if (!view || event.payload.roomSeq <= view.roomSeq) return; // already in the snapshot
    if (event.payload.roomSeq !== view.roomSeq + 1) {
      void this.resync();
      return;
    }
    if (event.type === 'sfu.activeSpeaker') {
      this.set({
        ...view,
        roomSeq: event.payload.roomSeq,
        activeSpeaker: event.payload.participantId,
      });
      return;
    }
    let members = view.members;
    if (event.type === 'participant.joined') {
      members = [...members, event.payload.participant];
    } else if (event.type === 'participant.left') {
      const gone = event.payload.participantId;
      members = members.filter((m) => m.participantId !== gone);
    } else {
      const { participantId, audioMuted, videoMuted, connection } = event.payload;
      members = members.map((m) =>
        m.participantId === participantId ? { ...m, audioMuted, videoMuted, connection } : m,
      );
    }
    this.set({ ...view, roomSeq: event.payload.roomSeq, members });
  }

  private async resync(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      console.warn('room: resync failed', err);
    }
  }

  private set(view: RoomSnapshot | null): void {
    this.current = view;
    for (const listener of this.listeners) listener();
  }
}
