import { z } from "zod";
import "./env-loader.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),

  API_PORT: z.coerce.number().int().positive().default(3001),
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:8080"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  SESSION_SECRET: z.string().min(16),
  SESSION_COOKIE_NAME: z.string().default("quiz_session"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(30),

  PLAYER_SESSION_COOKIE_NAME: z.string().default("player_session"),

  HOST_GRACE_PERIOD_MS: z.coerce.number().int().min(0).default(120_000),
  DEFAULT_TIME_LIMIT_SECONDS: z.coerce.number().int().min(3).max(600).default(20),

  SCORE_BASE: z.coerce.number().int().min(0).default(1000),
  SCORE_MIN_FRACTION: z.coerce.number().min(0).max(1).default(0.5),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: { env: AppEnv; error: z.ZodError | null } | undefined;

/** Parse + cache the environment. Throws with a readable message on first use if invalid. */
export function loadConfig(overrides: Record<string, unknown> = {}): AppEnv {
  const result = envSchema.safeParse({ ...process.env, ...overrides });
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  cached = { env: result.data, error: null };
  return result.data;
}

export function getConfig(): AppEnv {
  if (cached) return cached.env;
  return loadConfig();
}