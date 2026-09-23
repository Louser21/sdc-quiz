import { z } from "zod";
import { CLIENT_EVENTS, type ClientEventName } from "./events.js";

const ServerErrorEvent = z.object({
  type: z.literal("server:error"),
  code: z.string(),
  message: z.string(),
  retriable: z.boolean(),
});

const ServerGameStateEvent = z.object({
  type: z.literal("server:game-state"),
  state: z.unknown(),
});

const ServerHostStateEvent = z.object({
  type: z.literal("server:host-state"),
  state: z.unknown(),
});

const ServerPlayerJoinedEvent = z.object({
  type: z.literal("server:player-joined"),
  playerId: z.string().uuid(),
  nickname: z.string(),
  count: z.number().int(),
});

const ServerPlayerLeftEvent = z.object({
  type: z.literal("server:player-left"),
  playerId: z.string().uuid(),
  nickname: z.string(),
  count: z.number().int(),
});

const ServerLobbyUpdatedEvent = z.object({
  type: z.literal("server:lobby-updated"),
  players: z.unknown(),
});

const ServerQuestionStartedEvent = z.object({
  type: z.literal("server:question-started"),
  question: z.unknown(),
});

const ServerAnswerAcceptedEvent = z.object({
  type: z.literal("server:answer-accepted"),
  playerId: z.string().uuid(),
  points: z.number().int(),
  correct: z.boolean(),
  totalPoints: z.number().int(),
});

const ServerAnswerRejectedEvent = z.object({
  type: z.literal("server:answer-rejected"),
  playerId: z.string().uuid(),
  code: z.string(),
  reason: z.string(),
});

const ServerQuestionResultEvent = z.object({
  type: z.literal("server:question-result"),
  questionId: z.string().uuid(),
  correctOptionId: z.string().uuid(),
  selectedOptionId: z.string().uuid().nullable(),
  points: z.number().int(),
  isCorrect: z.boolean(),
  totalPoints: z.number().int(),
});

const ServerQuestionEndedEvent = z.object({
  type: z.literal("server:question-ended"),
  questionId: z.string().uuid(),
  answerCount: z.number().int(),
  optionCounts: z.unknown(),
  correctOptionId: z.string().uuid(),
});

const ServerLeaderboardUpdatedEvent = z.object({
  type: z.literal("server:leaderboard-updated"),
  entries: z.unknown(),
});

const ServerGameFinishedEvent = z.object({
  type: z.literal("server:game-finished"),
  leaderboard: z.unknown(),
});

const ServerHostPresenceEvent = z.object({
  type: z.literal("server:host-presence"),
  present: z.boolean(),
});

/**
 * Server -> client event registry. Payloads are typed by their `type` tag.
 * The concrete payload types live in app code as `ServerEventMap`.
 */
export const SERVER_EVENTS_BY_TYPE = {
  "server:error": ServerErrorEvent,
  "server:game-state": ServerGameStateEvent,
  "server:host-state": ServerHostStateEvent,
  "server:player-joined": ServerPlayerJoinedEvent,
  "server:player-left": ServerPlayerLeftEvent,
  "server:lobby-updated": ServerLobbyUpdatedEvent,
  "server:question-started": ServerQuestionStartedEvent,
  "server:answer-accepted": ServerAnswerAcceptedEvent,
  "server:answer-rejected": ServerAnswerRejectedEvent,
  "server:question-result": ServerQuestionResultEvent,
  "server:question-ended": ServerQuestionEndedEvent,
  "server:leaderboard-updated": ServerLeaderboardUpdatedEvent,
  "server:game-finished": ServerGameFinishedEvent,
  "server:host-presence": ServerHostPresenceEvent,
} as const;

export type ServerEventName = keyof typeof SERVER_EVENTS_BY_TYPE;

/**
 * Validate an inbound client event by name + payload.
 * Returns the parsed payload or throws a human-readable zod error.
 */
export function parseClientEvent(name: string, payload: unknown) {
  const schema = (CLIENT_EVENTS as Record<string, z.ZodType>)[name];
  if (!schema) {
    throw new Error(`Unknown client event: ${name}`);
  }
  return schema.parse(payload);
}

export function isClientEventName(name: string): name is ClientEventName {
  return name in CLIENT_EVENTS;
}