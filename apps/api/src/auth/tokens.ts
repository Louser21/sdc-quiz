import { createHash, randomBytes } from "node:crypto";

/** 256-bit random opaque session token (sent ONLY to the browser via cookie). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** Never store or log the raw token; persist only its sha256 hash. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}