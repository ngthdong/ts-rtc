import type { JoinResult } from '@ts-rtc/protocol';

/** What went wrong. Signaling and media fail and recover independently. */
export type Trouble =
  | 'reconnected' // a new socket after a drop: resume the membership first
  | 'media_reset' // the room's Worker died; a new Router replaced it
  | 'transport_closed' // the server closed one of our transports
  | 'ice_stuck'; // ICE disconnected > 5 s, or failed

export type Recovery = 'none' | 'wait' | 'restart_ice' | 'rebuild' | 'rejoin';

export interface Facts {
  trouble: Trouble;
  signalingReady: boolean;
  /** The resume was refused: the membership is gone (grace over). */
  resumeFailed?: boolean;
  /** After a resume: one of our transports no longer exists on the server. */
  transportsMissing?: boolean;
  /** After a resume: the room's Router changed while we were away. */
  routerChanged?: boolean;
  iceStuck: boolean;
}

/** The decision table (unit-tested): the cheapest step that can work. */
export function decide(f: Facts): Recovery {
  if (f.resumeFailed) return 'rejoin'; // a new participant: everything is built again
  if (!f.signalingReady) return 'wait'; // ICE restart and rebuild need signaling; resume decides
  const gone = f.trouble === 'media_reset' || f.trouble === 'transport_closed';
  if (gone || f.transportsMissing || f.routerChanged) return 'rebuild';
  return f.iceStuck ? 'restart_ice' : 'none';
}

/** What the call does for each decision (useCall provides them; Mesh has no media steps). */
export interface RecoveryActions {
  signalingReady(): boolean;
  iceStuck(): boolean;
  resume(): Promise<JoinResult | null>;
  /** After a resume: consume what was produced in the gap, drop what ended. */
  reconcile(result: JoinResult): Promise<void>;
  transportsMissing(alive: string[]): boolean;
  routerChanged(result: JoinResult): boolean;
  restartIce(): Promise<void>;
  rebuild(): Promise<void>;
  rejoin(): Promise<void>;
}

/** Runs one recovery at a time, so two troubles never rebuild concurrently. */
export class RecoveryManager {
  /** Decisions and their reasons, newest last (shown by the test hook and the console). */
  readonly log: string[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly actions: RecoveryActions) {}

  handle(trouble: Trouble): Promise<void> {
    this.queue = this.queue
      .then(() => this.run(trouble))
      .catch((err: unknown) => {
        console.warn('recovery: failed', trouble, err);
      });
    return this.queue;
  }

  private async run(trouble: Trouble): Promise<void> {
    const a = this.actions;
    const facts: Facts = { trouble, signalingReady: a.signalingReady(), iceStuck: a.iceStuck() };
    let resumed: JoinResult | null = null;
    if (trouble === 'reconnected') {
      resumed = await a.resume();
      facts.resumeFailed = !resumed;
      facts.transportsMissing = resumed ? a.transportsMissing(resumed.transportIds ?? []) : false;
      facts.routerChanged = resumed ? a.routerChanged(resumed) : false;
    }
    let decision = decide(facts);
    this.record(`${decision} (${trouble})`);
    if (decision === 'restart_ice') {
      try {
        await a.restartIce();
      } catch {
        decision = 'rebuild'; // the transport went away meanwhile
        this.record('rebuild (restart_ice failed)');
      }
    }
    if ((decision === 'none' || decision === 'restart_ice') && resumed) await a.reconcile(resumed);
    if (decision === 'rejoin') await a.rejoin();
    if (decision === 'rebuild' || decision === 'rejoin') await a.rebuild();
  }

  private record(entry: string): void {
    this.log.push(entry);
    console.info(`recovery: ${entry}`);
  }
}
