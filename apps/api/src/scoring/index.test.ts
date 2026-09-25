import { describe, expect, it, afterEach } from "vitest";
import { loadConfig } from "../config.js";
import { scoreForCorrectness, isWithinPaperDeadline } from "./index.js";

const base = {
  DATABASE_URL: "postgresql://quiz:quiz@localhost:5432/quiz",
  SESSION_SECRET: "0123456789abcdef",
};

afterEach(() => {
  loadConfig({ ...base }); // restore cache to a known state for subsequent tests
});

describe("scoreForCorrectness", () => {
  it("awards SCORE_BASE for a correct answer and 0 for a wrong one", () => {
    loadConfig({ ...base, SCORE_BASE: 250 });
    expect(scoreForCorrectness(true)).toBe(250);
    expect(scoreForCorrectness(false)).toBe(0);
  });

  it("is exact at SCORE_BASE=0 (nothing useful can be gained by gaming it)", () => {
    loadConfig({ ...base, SCORE_BASE: 0 });
    expect(scoreForCorrectness(true)).toBe(0);
    expect(scoreForCorrectness(false)).toBe(0);
  });

  it("resolves the points from server config, never from a caller-supplied value", () => {
    // The function shape is deliberately (boolean) => points; no client input.
    expect(scoreForCorrectness).toBeTypeOf("function");
    expect(scoreForCorrectness.length).toBe(1);
  });
});

describe("isWithinPaperDeadline", () => {
  it("accepts a server-now strictly before the deadline", () => {
    expect(isWithinPaperDeadline(999_999, 1_000_000)).toBe(true);
  });

  it("rejects exactly at the deadline and after it", () => {
    expect(isWithinPaperDeadline(1_000_000, 1_000_000)).toBe(false);
    expect(isWithinPaperDeadline(1_000_001, 1_000_000)).toBe(false);
  });
});