import type { FastifyInstance } from "fastify";
import { checkDatabase } from "../db/client.js";
import { checkRedis } from "../redis/client.js";

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    uptime: Math.round((Date.now() - startedAt) / 1000),
    now: Date.now(),
  }));

  app.get("/ready", async (_req, reply) => {
    const checks: Record<string, "ok" | "DOWN"> = { redis: "DOWN", database: "DOWN" };
    let ok = true;
    try {
      await checkRedis();
      checks.redis = "ok";
    } catch {
      ok = false;
    }
    try {
      await checkDatabase();
      checks.database = "ok";
    } catch {
      ok = false;
    }
    const status = ok ? 200 : 503;
    return reply.status(status).send({ status: ok ? "ready" : "not-ready", checks, now: Date.now() });
  });
}