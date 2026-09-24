import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { getConfig } from "./config.js";
import { getLogger } from "./logging/logger.js";
import { sendError, errors } from "./errors/index.js";
import { countHttpRequest } from "./observability/metrics.js";
import { healthRoutes } from "./routes/health.js";
import { authPlugin } from "./auth/plugin.js";
import { authRoutes } from "./routes/auth.routes.js";
import { quizRoutes } from "./routes/quizzes.routes.js";
import { gameRoutes } from "./routes/games.routes.js";
import { playRoutes } from "./routes/play.routes.js";

export interface BuildAppOptions {
  /** Skip plugins/behaviors that need external services. Defaults to false. */
  minimal?: boolean;
  /** Override rate-limit settings for the running instance (tests use tight values). */
  rateLimit?: {
    enabled?: boolean;
    globalMax?: number;
    loginMax?: number;
    registerMax?: number;
    joinMax?: number;
  };
}

// @fastify/rate-limit THROWS the value returned by errorResponseBuilder, so it
// must be an AppError for our shared error handler to emit the standard envelope.
const RATE_LIMIT_ERROR = () => errors.rateLimited();

export interface RateLimitOverrides {
  enabled: boolean;
  globalMax: number;
  loginMax: number;
  registerMax: number;
  joinMax: number;
}

export function resolveRateLimit(options: BuildAppOptions = {}): RateLimitOverrides {
  const config = getConfig();
  return {
    enabled: options.rateLimit?.enabled ?? config.RATE_LIMIT_ENABLED,
    globalMax: options.rateLimit?.globalMax ?? config.RATE_LIMIT_GLOBAL_MINUTE,
    loginMax: options.rateLimit?.loginMax ?? config.RATE_LIMIT_LOGIN_MINUTE,
    registerMax: options.rateLimit?.registerMax ?? config.RATE_LIMIT_REGISTER_MINUTE,
    joinMax: options.rateLimit?.joinMax ?? config.RATE_LIMIT_JOIN_MINUTE,
  };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = getConfig();
  const app = Fastify({
    loggerInstance: getLogger() as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.decorate("shuttingDown", false);

  // Prometheus request counter — registered before routes so it sees them all.
  app.addHook("onResponse", async (req, reply) => {
    const url = req.routeOptions?.url ?? req.url;
    if (url.startsWith("/api")) {
      countHttpRequest(req.method, url, reply.statusCode);
    }
  });

  // Error/not-found handlers MUST be registered before any plugins or routes:
  // Fastify v5 snapshots the error handler into route contexts at registration
  // time, so registering these after the routes silently reverted to the
  // framework default envelope ({statusCode, code, error, message}) instead of
  // our {error: {code, message}} contract.
  app.setErrorHandler((err, req, reply) => {
    const fastifyErr = err as FastifyError;
    if (fastifyErr.validation) {
      reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: fastifyErr.message },
      });
      return;
    }
    sendError(reply, err);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` } });
  });

  if (!options.minimal) {
    await app.register(cors, {
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      allowedHeaders: ["Content-Type", "Cookie"],
    });
    await app.register(cookie);
  }

  // HTTP rate limiting. Global floor (per IP) with stricter per-route limits on
  // brute-force surfaces (auth) and player-join. Memory store: single-instance.
  const rl = resolveRateLimit(options);
  if (rl.enabled) {
    await app.register(rateLimit, {
      global: true,
      max: rl.globalMax,
      timeWindow: "1 minute",
      errorResponseBuilder: RATE_LIMIT_ERROR,
    });
  }

  await app.register(healthRoutes, { prefix: "/api" });

  await app.register(authPlugin);
  await app.register(authRoutes, {
    prefix: "/api",
    rateLimit: { loginMax: rl.loginMax, registerMax: rl.registerMax },
  });
  await app.register(quizRoutes, { prefix: "/api" });
  await app.register(gameRoutes, { prefix: "/api" });
  await app.register(playRoutes, { prefix: "/api", rateLimit: { joinMax: rl.joinMax } });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    shuttingDown: boolean;
  }
}