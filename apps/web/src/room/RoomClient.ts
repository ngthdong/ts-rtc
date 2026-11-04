import type { MuteState, RoomMode, RoomSnapshot, SignalingEvent } from '@ts-rtc/protocol';
import type { SignalingClient } from '../signaling/SignalingClient.js';

export class RoomClient {
  private current: RoomSnapshot | null = null;
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(mode: RoomMode = 'mesh'): Promise<string> {
    const { roomId } = await this.signaling.request('room.create', { mode });
    return roomId;
  }

  async join(roomId: string, displayName: string): Promise<void> {
    this.held = [];
    this.closedReason = null;
    try {
      this.set(await this.signaling.request('room.join', { roomId, displayName }));
      for (const event of this.held) this.apply(event);
    } finally {
      this.held = null;
    }
  }

  async leave(): Promise<void> {
    await this.signaling.request('room.leave', {});
    this.set(null);
  }

  async setMuted(state: MuteState): Promise<void> {
    await this.signaling.request('participant.update', state);
  }

  private apply(event: SignalingEvent): void {
    if (event.type === 'room.closed') {
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
    let members = view.members;
    if (event.type === 'participant.joined') {
      members = [...members, event.payload.participant];
    } else if (event.type === 'participant.left') {
      const gone = event.payload.participantId;
      members = members.filter((m) => m.participantId !== gone);
    } else {
      const { participantId, audioMuted, videoMuted } = event.payload;
      members = members.map((m) =>
        m.participantId === participantId ? { ...m, audioMuted, videoMuted } : m,
      );
    }
    this.set({ ...view, roomSeq: event.payload.roomSeq, members });
  }

  private async resync(): Promise<void> {
    try {
      this.set(await this.signaling.request('room.sync', {}));
    } catch (err) {
      console.warn('room: resync failed', err);
    }
  }

  private set(view: RoomSnapshot | null): void {
    this.current = view;
    for (const listener of this.listeners) listener();
  }
}
