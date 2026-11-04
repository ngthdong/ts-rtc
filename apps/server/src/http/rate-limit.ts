import { SignalingError } from '@ts-rtc/protocol';

/** Per-key token bucket (key: client IP): `burst` at once, refilled at `perMinute`. One server. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly burst: number,
    private readonly perMinute: number,
  ) {}

  take(key: string, now = Date.now()): void {
    if (this.buckets.size > 10_000) this.buckets.clear(); // bounded memory; a reset only forgives
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + ((now - bucket.at) * this.perMinute) / 60_000,
    );
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) throw new SignalingError('RATE_LIMITED', 'too many attempts, try later');
    bucket.tokens -= 1;
  }
}
