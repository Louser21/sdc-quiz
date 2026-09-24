import { z } from "zod";
import {
  HostGameStateView,
  HostQuestionResult,
  HostQuestionView,
  LeaderboardEntry,
  PlayerGameStateView,
  PlayerLobbyEntry,
  PlayerQuestionResult,
  QuestionPayload,
} from "./types.js";
import { ID_SCHEMA, JOIN_CODE_SCHEMA, NICKNAME_SCHEMA } from "./constants.js";

/** Optional idempotency key for host commands. Same runId + same command => no-op. */
export const RUN_ID = z.string().min(8).max(64).optional();

export const PlayerJoinEvent = z.object({
  gameCode: JOIN_CODE_SCHEMA,
  nickname: NICKNAME_SCHEMA,
});
export type PlayerJoinEvent = z.infer<typeof PlayerJoinEvent>;

export const PlayerSyncEvent = z.object({});
export type PlayerSyncEvent = z.infer<typeof PlayerSyncEvent>;

export const PlayerHeartbeatEvent = z.object({});
export type PlayerHeartbeatEvent = z.infer<typeof PlayerHeartbeatEvent>;

export const PlayerSubmitAnswerEvent = z.object({
  gameId: ID_SCHEMA,
  questionId: ID_SCHEMA,
  optionId: ID_SCHEMA,
});
export type PlayerSubmitAnswerEvent = z.infer<typeof PlayerSubmitAnswerEvent>;

export const HostStartQuestionEvent = z.object({
  gameId: ID_SCHEMA,
  questionId: ID_SCHEMA,
  runId: RUN_ID,
});
export type HostStartQuestionEvent = z.infer<typeof HostStartQuestionEvent>;

export const HostEndQuestionEvent = z.object({
  gameId: ID_SCHEMA,
  runId: RUN_ID,
});
export type HostEndQuestionEvent = z.infer<typeof HostEndQuestionEvent>;

export const HostNextQuestionEvent = z.object({
  gameId: ID_SCHEMA,
  runId: RUN_ID,
});
export type HostNextQuestionEvent = z.infer<typeof HostNextQuestionEvent>;

export const HostEndGameEvent = z.object({
  gameId: ID_SCHEMA,
  runId: RUN_ID,
});
export type HostEndGameEvent = z.infer<typeof HostEndGameEvent>;

export const HostSyncEvent = z.object({});
export type HostSyncEvent = z.infer<typeof HostSyncEvent>;

export const HostJoinGameEvent = z.object({
  gameId: ID_SCHEMA,
  runId: RUN_ID,
});
export type HostJoinGameEvent = z.infer<typeof HostJoinGameEvent>;

/**
 * Client -> server event registry. Every inbound event is validated against
 * its schema before the handler runs. Unknown/ill-shaped events are rejected.
 */
export const CLIENT_EVENTS = {
  "player:join": PlayerJoinEvent,
  "player:sync": PlayerSyncEvent,
  "player:heartbeat": PlayerHeartbeatEvent,
  "player:submit-answer": PlayerSubmitAnswerEvent,
  "host:start-question": HostStartQuestionEvent,
  "host:end-question": HostEndQuestionEvent,
  "host:next-question": HostNextQuestionEvent,
  "host:end-game": HostEndGameEvent,
  "host:join-game": HostJoinGameEvent,
  "host:sync": HostSyncEvent,
} as const;

export type ClientEventName = keyof typeof CLIENT_EVENTS;
export type ClientEventPayload<T extends ClientEventName> = z.infer<
  (typeof CLIENT_EVENTS)[T]
>;

// ---------------------------------------------------------------------------
// Server -> client events
// ---------------------------------------------------------------------------

export const GameQuestionResultEvent = z.object({
  questionId: ID_SCHEMA,
  correctOptionId: ID_SCHEMA,
});

export const PlayerAnswerAckEvent = z.object({
  questionId: ID_SCHEMA,
  accepted: z.boolean(),
  reason: z.string().optional(),
  answerCount: z.number().int().min(0),
});
export type PlayerAnswerAckEvent = z.infer<typeof PlayerAnswerAckEvent>;

export const GameFinishedEvent = z.object({
  gameId: ID_SCHEMA,
  joinCode: JOIN_CODE_SCHEMA,
  quizTitle: z.string(),
  leaderboard: z.array(LeaderboardEntry),
});
export type GameFinishedEvent = z.infer<typeof GameFinishedEvent>;

export const HostQuestionResultEvent = z.object({
  questionId: ID_SCHEMA,
  correctOptionId: ID_SCHEMA,
  optionCounts: z.array(z.object({ optionId: ID_SCHEMA, count: z.number().int().min(0) })),
  answerCount: z.number().int().min(0),
  leaderboard: z.array(LeaderboardEntry),
});
export type HostQuestionResultEvent = z.infer<typeof HostQuestionResultEvent>;

export const HostAnswerCountEvent = z.object({
  questionId: ID_SCHEMA,
  answerCount: z.number().int().min(0),
});

export const HostGameFinishedEvent = z.object({
  gameId: ID_SCHEMA,
  joinCode: JOIN_CODE_SCHEMA,
  quizTitle: z.string(),
  leaderboard: z.array(LeaderboardEntry),
});
export type HostGameFinishedEvent = z.infer<typeof HostGameFinishedEvent>;

export const SocketErrorEvent = z.object({
  code: z.string(),
  message: z.string(),
});
export type SocketErrorEvent = z.infer<typeof SocketErrorEvent>;

/**
 * Server -> client event registry. Every outbound payload is validated against
 * these schemas before it is emitted (defense-in-depth on top of the types).
 */
export const SERVER_EVENTS = {
  "player:state": PlayerGameStateView,
  "player:answer-ack": PlayerAnswerAckEvent,
  "player:question-result": PlayerQuestionResult,
  "game:question": QuestionPayload,
  "game:question-result": GameQuestionResultEvent,
  "game:finished": GameFinishedEvent,
  "host:state": HostGameStateView,
  "host:question-started": HostQuestionView,
  "host:question-result": HostQuestionResultEvent,
  "host:answer-count": HostAnswerCountEvent,
  "host:player-updated": PlayerLobbyEntry,
  "host:game-finished": HostGameFinishedEvent,
  "error": SocketErrorEvent,
} as const;

export type ServerEventName = keyof typeof SERVER_EVENTS;
export type ServerEventPayload<T extends ServerEventName> = z.infer<
  (typeof SERVER_EVENTS)[T]
>;