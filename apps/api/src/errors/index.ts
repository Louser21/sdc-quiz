import type { FastifyReply } from "fastify";

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
  | "QUESTION_NOT_ACTIVE"
  | "ALREADY_ANSWERED"
  | "ANSWER_TOO_LATE"
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
  questionNotActive: (msg = "No question is currently active") =>
    new AppError("QUESTION_NOT_ACTIVE", msg, 409),
  alreadyAnswered: (msg = "You already answered this question") =>
    new AppError("ALREADY_ANSWERED", msg, 409),
  answerTooLate: (msg = "Answer submitted after the deadline") =>
    new AppError("ANSWER_TOO_LATE", msg, 409),
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