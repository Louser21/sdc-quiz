import { Redis } from "ioredis";
import { getConfig } from "../config.js";
import { getLogger } from "../logging/logger.js";

declare global {
  var __redis: Redis | undefined;
}

function create(): Redis {
  const redis = new Redis(getConfig().REDIS_URL, {
    maxRetriesPerRequest: null,
    // Do not buffer commands forever when Redis is down; let readiness checks fail.
    enableOfflineQueue: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on("error", (err) => {
    getLogger().warn({ err: err.message }, "redis error");
  });
  redis.on("connect", () => getLogger().info("redis connected"));
  return redis;
}

export const redis: Redis = globalThis.__redis ?? create();

if (process.env.NODE_ENV !== "production") {
  globalThis.__redis = redis;
}

export async function checkRedis(): Promise<void> {
  const pong = await redis.ping();
  if (pong !== "PONG") throw new Error("redis readiness check failed");
}

export default redis;