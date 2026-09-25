import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenBucket } from "./token-bucket.js";

describe("TokenBucket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the configured burst within capacity", () => {
    const bucket = new TokenBucket(3, 1);
    for (let i = 0; i < 3; i++) expect(bucket.take("room")).toBe(true);
  });

  it("rejects beyond capacity until tokens refill", () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(3, 1);
    for (let i = 0; i < 3; i++) expect(bucket.take("room")).toBe(true);
    expect(bucket.take("room")).toBe(false);

    // Refill is continuous: 1 token for ~every second elapsed.
    vi.setSystemTime(Date.now() + 1000);
    expect(bucket.take("room")).toBe(true);
    expect(bucket.take("room")).toBe(false);

    vi.setSystemTime(Date.now() + 1000);
    expect(bucket.take("room")).toBe(true);
  });

  it("never refills above capacity, even after a long pause", () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(2, 10);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(false);

    // 60s idle at 10/s would refill to 600 if uncapped; must cap at 2.
    vi.setSystemTime(Date.now() + 60_000);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(false);
  });

  it("keeps independent buckets per identity", () => {
    const bucket = new TokenBucket(1, 1);
    expect(bucket.take("bot-a")).toBe(true);
    expect(bucket.take("bot-a")).toBe(false);
    // A different identity does not inherit the drained bucket.
    expect(bucket.take("bot-b")).toBe(true);
  });

  it("sweeps idle entries once the map grows past maxEntries", () => {
    vi.useFakeTimers();
    // maxEntries=3: exhaust a key, let it go idle past the 2-min cutoff, then
    // churn fresh keys so the map grows; a failing take triggers the sweep.
    const bucket = new TokenBucket(1, 1, 3) as unknown as {
      take(k: string): boolean;
      buckets: Map<string, { tokens: number; last: number }>;
    };
    expect(bucket.take("idle-old")).toBe(true);
    vi.setSystemTime(Date.now() + 121_000);

    for (let i = 0; i < 5; i++) expect(bucket.take(`churn-${i}`)).toBe(true);
    expect(bucket.buckets.size).toBe(6); // grown well past maxEntries

    // Force a sweep via a failing take on a freshly exhausted key.
    expect(bucket.take("exhaust")).toBe(true);
    expect(bucket.take("exhaust")).toBe(false);
    // The idle entry was pruned; recent entries are retained. The map was 6,
    // grew to 7 with "exhaust", then settled back to 6 after the sweep.
    expect(bucket.buckets.has("idle-old")).toBe(false);
    expect(bucket.buckets.size).toBe(6);
    expect(bucket.buckets.has("churn-0")).toBe(true);
  });
});