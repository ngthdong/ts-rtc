import type { PeerQualityReport } from '@ts-rtc/protocol';
import { selectedPath, type SelectedPath } from '../diagnostics/ice.js';

export type Stat = Record<string, unknown> & { id: string; type: string; timestamp: number };
export type Stats = ReadonlyMap<string, Stat>;

/** One peer connection over the last sampling window. null = not measurable (yet). */
export interface PeerQuality {
  rttMs: number | null;
  lossPct: number | null; // inbound, worst stream (video hides loss: NACK/RTX recovers it)
  jitterMs: number | null; // inbound, worst stream
  inKbps: number | null;
  outKbps: number | null;
  video: { width: number; height: number; fps: number } | null; // what we receive
  limitation: PeerQualityReport['limitation']; // why our encoder sends less, Chromium only
  path: SelectedPath | null;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Rates come from deltas of cumulative counters between two reports, never from the counters
 * themselves. A stat that is new (new SSRC) or whose counter went down has no delta.
 */
export function computeQuality(current: Stats, previous: Stats | undefined): PeerQuality {
  let inKbps: number | null = null;
  let outKbps: number | null = null;
  let lossPct: number | null = null;
  let jitterMs: number | null = null;
  let remoteRttMs: number | null = null;
  let video: PeerQuality['video'] = null;
  let limitation: PeerQuality['limitation'] = null;

  for (const stat of current.values()) {
    const before = previous?.get(stat.id);
    const seconds = before ? (stat.timestamp - before.timestamp) / 1000 : 0;
    const delta = (key: string): number | null => {
      if (!before || seconds <= 0) return null;
      const d = num(stat[key]) - num(before[key]);
      return d >= 0 ? d : null; // counter reset: skip, never a negative rate
    };
    const kbps = (key: string) => {
      const bytes = delta(key);
      return bytes === null ? null : (8 * bytes) / seconds / 1000;
    };
    const kind = stat.kind ?? stat.mediaType; // older Firefox: mediaType only

    if (stat.type === 'inbound-rtp') {
      const rate = kbps('bytesReceived');
      if (rate !== null) inKbps = (inKbps ?? 0) + rate;
      const [got, missed] = [delta('packetsReceived'), delta('packetsLost')];
      // Both from the same window or neither: a half reset would read as 100 % loss.
      if (got !== null && missed !== null && got + missed > 0) {
        lossPct = Math.max(lossPct ?? 0, (100 * missed) / (got + missed));
      }
      if (typeof stat.jitter === 'number') jitterMs = Math.max(jitterMs ?? 0, stat.jitter * 1000);
      if (kind === 'video' && stat.frameWidth !== undefined) {
        const frames = delta('framesDecoded');
        video = {
          width: num(stat.frameWidth),
          height: num(stat.frameHeight),
          fps: frames === null ? num(stat.framesPerSecond) : frames / seconds,
        };
      }
    } else if (stat.type === 'outbound-rtp') {
      const rate = kbps('bytesSent');
      if (rate !== null) outKbps = (outKbps ?? 0) + rate;
      if (kind === 'video' && typeof stat.qualityLimitationReason === 'string') {
        const reason = stat.qualityLimitationReason;
        limitation =
          reason === 'none' || reason === 'cpu' || reason === 'bandwidth' ? reason : 'other';
      }
    } else if (stat.type === 'remote-inbound-rtp' && typeof stat.roundTripTime === 'number') {
      remoteRttMs = Math.max(remoteRttMs ?? 0, stat.roundTripTime * 1000);
    }
  }

  const path = selectedPath(current);
  return {
    rttMs: path?.rttMs ?? (remoteRttMs === null ? null : Math.round(remoteRttMs)),
    lossPct,
    jitterMs,
    inKbps,
    outKbps,
    video,
    limitation,
    path,
  };
}

/** Polls connections and keeps each one's previous report, so every sample is a delta. */
export class StatsCollector {
  private previous = new Map<string, Stats>();

  async sample(connections: Map<string, RTCPeerConnection>): Promise<Record<string, PeerQuality>> {
    const result: Record<string, PeerQuality> = {};
    const next = new Map<string, Stats>(); // peers that left are forgotten here
    for (const [id, pc] of connections) {
      const stats = new Map<string, Stat>();
      (await pc.getStats()).forEach((stat: Stat) => stats.set(stat.id, stat));
      result[id] = computeQuality(stats, this.previous.get(id));
      next.set(id, stats);
    }
    this.previous = next;
    return result;
  }
}

const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const;
const candidateType = (type: string | undefined) => CANDIDATE_TYPES.find((t) => t === type) ?? null;

/** What goes to the server: derived numbers and candidate types, never addresses. */
export function toReport(peer: string, q: PeerQuality): PeerQualityReport {
  const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
  const protocol = q.path?.protocol;
  return {
    peer,
    rttMs: round(q.rttMs),
    lossPct: round(q.lossPct),
    jitterMs: round(q.jitterMs),
    inKbps: round(q.inKbps),
    outKbps: round(q.outKbps),
    pairLocal: candidateType(q.path?.local),
    pairRemote: candidateType(q.path?.remote),
    protocol: protocol === 'udp' || protocol === 'tcp' ? protocol : null,
    limitation: q.limitation,
  };
}
