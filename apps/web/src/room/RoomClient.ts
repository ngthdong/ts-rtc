import type { RoomSnapshot, SignalingEvent } from '@ts-rtc/protocol';
import type { SignalingClient } from '../signaling/SignalingClient.js';

export class RoomClient {
  private current: RoomSnapshot | null = null;
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

  async create(displayName: string): Promise<void> {
    const { roomId } = await this.signaling.request('room.create', {});
    await this.join(roomId, displayName);
  }

  async join(roomId: string, displayName: string): Promise<void> {
    this.held = [];
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

  private apply(event: SignalingEvent): void {
    const view = this.current;
    if (!view || event.payload.roomSeq <= view.roomSeq) return; // already in the snapshot
    if (event.payload.roomSeq !== view.roomSeq + 1) {
      void this.resync();
      return;
    }
    const members =
      event.type === 'participant.joined'
        ? [...view.members, event.payload.participant]
        : view.members.filter((m) => m.participantId !== event.payload.participantId);
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
