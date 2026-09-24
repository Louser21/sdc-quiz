/**
 * In-memory token bucket for WebSocket event rate limiting.
 *
 * Event handlers are already hot paths; the only state needed to gate a
 * reconnect/refresh or a bot is a per-identity token count, so this lives in
 * process memory. Documented trade-off: buckets are per-instance (fine for the
 * single-node compose deployment). A horizontally-scaled deployment would move
 * these counters to Redis.
 */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; last: number }>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly maxEntries: number;

  constructor(capacity: number, refillPerSec: number, maxEntries = 4000) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxEntries = maxEntries;
  }

  /** Consume one token if available; returns true when the action may proceed. */
  take(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = (now - bucket.last) / 1000;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSec);
      bucket.last = now;
    }
    if (bucket.tokens < 1) {
      this.sweep(now);
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  private sweep(now: number): void {
    if (this.buckets.size <= this.maxEntries) return;
    const cutoff = now - 120_000; // entries idle for 2 min are droppable
    for (const [key, bucket] of this.buckets) {
      if (bucket.last < cutoff) this.buckets.delete(key);
      if (this.buckets.size <= this.maxEntries) break;
    }
  }
}

// Player actions (set-answer / mark-review / submit-paper): burst of 40,
// refilling at 5/s (300/min sustained) — plenty for legit editing, fatal for floods.
export const playerActionBucket = new TokenBucket(40, 5);
// Host commands (join / start / end): burst of 10, refilling at 1/s.
export const hostActionBucket = new TokenBucket(10, 1);