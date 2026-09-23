import pino, { type Logger } from "pino";
import { getConfig } from "../config.js";

let logger: Logger | undefined;

export function getLogger(): Logger {
  if (!logger) {
    logger = pino({
      level: getConfig().LOG_LEVEL,
      base: { service: "quiz-api" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    });
  }
  return logger;
}

/**
 * Structured domain-event logger (section 30 of spec).
 * Usage: logGame("GAME_STARTED", { gameId, quizId })
 */
export function logGame(event: string, fields: Record<string, unknown> = {}): void {
  getLogger().info({ evt: event, ...fields }, event);
}