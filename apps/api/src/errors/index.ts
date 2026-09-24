import type { FastifyReply } from "fastify";
import { z } from "zod";

/** Error codes shared between REST and WebSocket surfaces. */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "GAME_NOT_JOINABLE"
  | "NICKNAME_TAKEN"
  | "RATE_LIMITED"
  | "INVALID_GAME_CODE"
  | "INVALID_SESSION"
  | "GAME_FINISHED"
  | "PAPER_NOT_ACTIVE"
  | "PAPER_ENDED"
  | "PLAYER_ALREADY_SUBMITTED"
  | "INVALID_OPTION"
  | "INVALID_TRANSITION"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number = 400,
    readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Parse/validate with a zod schema, mapping failures to a 400 AppError. */
export function parseWith<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      result.error.issues[0]?.message ?? "Invalid input",
      400,
    );
  }
  return result.data;
}

/** Prisma error code helpers (driver adapters surface PrismaError.code). */
export function prismaCode(e: unknown): string | undefined {
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
export function isUniqueViolation(e: unknown): boolean {
  return prismaCode(e) === "P2002";
}
export function isForeignKeyViolation(e: unknown): boolean {
  return prismaCode(e) === "P2003";
}

export const errors = {
  validation: (msg = "Invalid input") => new AppError("VALIDATION_ERROR", msg, 400),
  unauthorized: (msg = "Authentication required") => new AppError("UNAUTHORIZED", msg, 401),
  forbidden: (msg = "Forbidden") => new AppError("FORBIDDEN", msg, 403),
  notFound: (msg = "Not found") => new AppError("NOT_FOUND", msg, 404),
  conflict: (msg = "Conflict") => new AppError("CONFLICT", msg, 409),
  gameNotJoinable: (msg = "This game is not accepting players") =>
    new AppError("GAME_NOT_JOINABLE", msg, 409),
  nicknameTaken: (msg = "That nickname is already in use on this device/game") =>
    new AppError("NICKNAME_TAKEN", msg, 409),
  rateLimited: (msg = "Too many requests") => new AppError("RATE_LIMITED", msg, 429),
  invalidGameCode: (msg = "Invalid game code") => new AppError("INVALID_GAME_CODE", msg, 404),
  invalidSession: (msg = "Invalid or expired session") =>
    new AppError("INVALID_SESSION", msg, 401),
  gameFinished: (msg = "Game has already finished") => new AppError("GAME_FINISHED", msg, 409),
  paperNotActive: (msg = "The paper is not currently active") =>
    new AppError("PAPER_NOT_ACTIVE", msg, 409),
  paperEnded: (msg = "The paper has already ended") => new AppError("PAPER_ENDED", msg, 409),
  alreadySubmitted: (msg = "You already submitted your paper") =>
    new AppError("PLAYER_ALREADY_SUBMITTED", msg, 409),
  invalidOption: (msg = "Option does not belong to this question") =>
    new AppError("INVALID_OPTION", msg, 400),
  invalidTransition: (msg = "Invalid game state transition") =>
    new AppError("INVALID_TRANSITION", msg, 409),
  internal: (msg = "Internal error") => new AppError("INTERNAL_ERROR", msg, 500, true),
  unavailable: (msg = "Service temporarily unavailable") =>
    new AppError("SERVICE_UNAVAILABLE", msg, 503, true),
};

export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AppError) {
    reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof Error) {
    reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal error" },
    });
    return;
  }
  reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal error" } });
}