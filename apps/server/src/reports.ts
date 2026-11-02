import { SignalingError, type ClientReport } from '@ts-rtc/protocol';
import type { RequestRouter } from './router.js';
import type { Session } from './session.js';

/** Per session and kind: up to `burst` at once, then one per `everyMs`. */
const LIMITS = {
  quality: { burst: 1, everyMs: 5_000 }, // the client sends one every 10 s
  state: { burst: 10, everyMs: 1_000 }, // a group join changes several peers at once
} as const;

type Kind = ClientReport['kind'];
const buckets = new WeakMap<Session, Record<Kind, { tokens: number; at: number }>>();

function allow(session: Session, kind: Kind, now = Date.now()): boolean {
  let own = buckets.get(session);
  if (!own) {
    own = {
      quality: { tokens: LIMITS.quality.burst, at: now },
      state: { tokens: LIMITS.state.burst, at: now },
    };
    buckets.set(session, own);
  }
  const { burst, everyMs } = LIMITS[kind];
  const bucket = own[kind];
  bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) / everyMs);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Client telemetry goes to the log, correlated with room and participant. Nothing is kept. */
export function registerReportHandlers(router: RequestRouter): void {
  router.on('client.report', (report, { session }) => {
    const binding = session.binding;
    if (!binding) throw new SignalingError('INVALID_STATE', 'not in a room');
    if (!allow(session, report.kind)) {
      throw new SignalingError('RATE_LIMITED', `too many ${report.kind} reports`);
    }
    const log = session.log.child({
      roomId: binding.room.id,
      participantId: binding.participantId,
    });
    if (report.kind === 'state') {
      log.info({ peer: report.peer, state: report.state }, 'client.state');
    } else {
      for (const peer of report.peers) log.info(peer, 'client.quality'); // one line per peer
    }
    return {};
  });
}
