import { z } from "zod";

/** Unambiguous alphabet for join codes: no 0/O, 1/I/L confusions. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;

export const JOIN_CODE_SCHEMA = z
  .string()
  .regex(
    new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`),
    `Join code must be ${JOIN_CODE_LENGTH} characters from the unambiguous alphabet`
  );

export const NICKNAME_MIN_LENGTH = 1;
export const NICKNAME_MAX_LENGTH = 24;
export const NICKNAME_SCHEMA = z
  .string()
  .trim()
  .min(NICKNAME_MIN_LENGTH, "Nickname must not be empty")
  .max(NICKNAME_MAX_LENGTH, `Nickname must be at most ${NICKNAME_MAX_LENGTH} characters`)
  .regex(/^[\p{L}\p{N} _.-]+$/u, "Nickname contains disallowed characters")
  .transform((v) => v.trim());

export const ID_SCHEMA = z.string().uuid();

export const DEFAULT_TIME_LIMIT_SECONDS = 20;

/** Fine-grained live phases. Persisted broad status is separate in Postgres. */
export const GAME_PHASES = [
  "LOBBY",
  "QUESTION_ACTIVE",
  "QUESTION_RESULTS",
  "FINISHED",
] as const;

/** DB-level game session lifecycle. */
export const GAME_SESSION_STATUSES = [
  "CREATED",
  "ACTIVE",
  "FINISHED",
  "ABANDONED",
] as const;

/** Valid state-machine transitions (Phase 3 enforces these in Redis). */
export const GAME_TRANSITIONS: Record<GamePhase, readonly GamePhase[]> = {
  LOBBY: ["QUESTION_ACTIVE"],
  QUESTION_ACTIVE: ["QUESTION_RESULTS", "FINISHED"],
  QUESTION_RESULTS: ["QUESTION_ACTIVE", "FINISHED"],
  FINISHED: [],
};

export type GamePhase = (typeof GAME_PHASES)[number];
export type GameSessionStatus = (typeof GAME_SESSION_STATUSES)[number];

export function stageName(phase: GamePhase): string {
  return phase;
}