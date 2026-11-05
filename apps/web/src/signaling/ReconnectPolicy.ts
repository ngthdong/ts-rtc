/** Reconnect schedule: full-jitter exponential backoff (delay = random(0, min(cap, base · 2^n))). */
export const RECONNECT = { baseMs: 500, capMs: 10_000, maxAttempts: 8 } as const;

/** ≈ 45 s worst case over 8 attempts: past the server's 30 s grace on purpose, so the last
 * attempts get a clear "session expired" and a fresh join instead of silence. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  return random() * Math.min(RECONNECT.capMs, RECONNECT.baseMs * 2 ** attempt);
}

/** Closes after which another attempt cannot help: deliberate, sign in again, or replaced. */
const FINAL: ReadonlySet<number> = new Set([1000, 4400, 4401, 4409]);

export function shouldReconnect(code: number | null): boolean {
  return code === null || !FINAL.has(code);
}
