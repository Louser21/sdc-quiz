import { loadConfig, getConfig } from "./config.js";
import { buildApp } from "./app.js";
import { attachSockets } from "./sockets/index.js";
import { setIo } from "./sockets/instance.js";
import { prisma } from "./db/client.js";
import { redis } from "./redis/client.js";
import { getLogger, logGame } from "./logging/logger.js";

async function main(): Promise<void> {
  loadConfig();
  const logger = getLogger();
  const config = getConfig();

  const app = await buildApp();
  await app.ready();

  // Attach Socket.IO to the Fastify HTTP server before it starts accepting.
  const io = attachSockets(app.server);
  setIo(io);

  await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
  app.shuttingDown = false;
  logGame("SERVER_STARTED", { port: config.API_PORT, env: config.NODE_ENV });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.shuttingDown = true;
    logger.info({ signal }, "graceful shutdown started");
    const force = setTimeout(() => {
      logger.error("forced shutdown after 10s");
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
      io.close();
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
      logger.info("graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "shutdown error");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Ensure integrity checks surface loudly instead of silently degrading.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.stack : String(reason) }, "unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err: err.stack }, "uncaughtException");
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error", err);
  process.exit(1);
});