import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePlayerToken, hashPlayerToken } from "./session.js";

describe("generatePlayerToken", () => {
  it("produces 64 lowercase hex chars (256 bits of entropy)", () => {
    expect(generatePlayerToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats across many draws", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generatePlayerToken()));
    expect(seen.size).toBe(1000);
  });
});

describe("hashPlayerToken", () => {
  it("is a deterministic sha256 hex digest of the raw token", () => {
    const token = "a-raw-cookie-token";
    expect(hashPlayerToken(token)).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });

  it("hashes equal tokens identically and different tokens differently", () => {
    const t = "cookie-value";
    expect(hashPlayerToken(t)).toBe(hashPlayerToken(t));
    expect(hashPlayerToken(t)).not.toBe(hashPlayerToken(`${t}x`));
  });

  it("never stores the plaintext token", () => {
    // The DB stores sha256(session); the raw value must not equal the digest.
    const raw = "super-secret-session";
    expect(hashPlayerToken(raw)).not.toBe(raw);
    expect(hashPlayerToken(raw)).toEqual(expect.any(String));
  });

  it("always hashes to 64 hex chars regardless of input length", () => {
    for (const input of ["", "a", "x".repeat(10_000)]) {
      expect(hashPlayerToken(input)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});