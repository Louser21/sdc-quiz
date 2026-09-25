import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { getConfig } from "../config.js";
import { getLogger } from "../logging/logger.js";

declare global {
  var __prisma: PrismaClient | undefined;
}

function createPrisma(): PrismaClient {
  const config = getConfig();
  const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log:
      config.NODE_ENV === "development"
        ? [{ emit: "event", level: "query" }, { emit: "event", level: "warn" }]
        : [{ emit: "event", level: "warn" }],
  });
}

export const prisma: PrismaClient = globalThis.__prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}

const logger = getLogger();
prisma.$on("warn" as never, (e: unknown) => {
  logger.warn({ event: "prisma-warn", e }, "prisma warning");
});

export async function checkDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export default prisma;