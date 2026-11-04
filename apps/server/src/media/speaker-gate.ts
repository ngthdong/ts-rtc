/**
 * Turns mediasoup's dominant-speaker changes into calm UI events: a change is emitted at once
 * if the last emitted change is at least `holdMs` old, otherwise when the hold ends (if it is
 * still a change by then). With holdMs ≥ 1 s this is also the "at most 1 event/s" rate limit.
 */
export class SpeakerGate {
  private last: string | undefined;
  private lastAt = -Infinity;
  private pending: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly emit: (participantId: string) => void,
    private readonly holdMs = 1_500,
  ) {}

  offer(participantId: string): void {
    this.pending = participantId;
    const wait = this.lastAt + this.holdMs - Date.now();
    if (wait <= 0) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), wait);
  }

  close(): void {
    clearTimeout(this.timer);
  }

  private flush(): void {
    this.timer = undefined;
    const next = this.pending;
    this.pending = undefined;
    if (next === undefined || next === this.last) return; // back to the same speaker: no event
    this.last = next;
    this.lastAt = Date.now();
    this.emit(next);
  }
}
