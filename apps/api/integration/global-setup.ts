import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Integration tests run against real Postgres + Redis (local compose stack).
// This global setup ensures migrations are applied and the env is present.
export default async function globalSetup(): Promise<void> {
  // Vitest sets NODE_ENV=test by default; the app config is strict about it.
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL ??= "postgresql://quiz:quiz@localhost:5432/quiz";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.SESSION_SECRET ??= "integration-test-secret-0123456789abcdef";
  process.env.FRONTEND_ORIGIN ??= "http://localhost:8080";

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../..");
  try {
    execSync("npx prisma migrate deploy", {
      cwd: repoRoot,
      env: process.env as Record<string, string>,
      stdio: "pipe",
    });
  } catch (e) {
    // Integration tests fail loudly later if the DB is actually unreachable.
    process.stderr.write(
      `Warning: prisma migrate deploy failed in global setup: ${(e as Error).message}\n`,
    );
  }

  // Isolation: a stale Redis leaves rate-limit windows, live-game keys, and
  // /metrics counters that bleed into later runs. Start every suite from the
  // same clean slate as the DB.
  try {
    const { redis } = await import("../src/redis/client.js");
    await redis.flushall();
    process.stderr.write("[global-setup] Redis flushed\n");
  } catch (e) {
    process.stderr.write(
      `Warning: redis flushall failed in global setup: ${(e as Error).message}\n`,
    );
  }
}