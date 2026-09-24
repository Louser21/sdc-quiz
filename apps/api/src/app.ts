import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { getConfig } from "./config.js";
import { getLogger } from "./logging/logger.js";
import { sendError } from "./errors/index.js";
import { healthRoutes } from "./routes/health.js";
import { authPlugin } from "./auth/plugin.js";
import { authRoutes } from "./routes/auth.routes.js";
import { quizRoutes } from "./routes/quizzes.routes.js";
import { gameRoutes } from "./routes/games.routes.js";
import { playRoutes } from "./routes/play.routes.js";

export interface BuildAppOptions {
  /** Skip plugins/behaviors that need external services. Defaults to false. */
  minimal?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = getConfig();
  const app = Fastify({
    loggerInstance: getLogger() as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.decorate("shuttingDown", false);

  if (!options.minimal) {
    await app.register(cors, {
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      allowedHeaders: ["Content-Type", "Cookie"],
    });
    await app.register(cookie);
  }

  await app.register(healthRoutes, { prefix: "/api" });

  await app.register(authPlugin);
  await app.register(authRoutes, { prefix: "/api" });
  await app.register(quizRoutes, { prefix: "/api" });
  await app.register(gameRoutes, { prefix: "/api" });
  await app.register(playRoutes, { prefix: "/api" });

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

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    shuttingDown: boolean;
  }
}