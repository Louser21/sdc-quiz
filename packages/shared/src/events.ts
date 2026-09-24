import { z } from "zod";
import {
  HostGameStateView,
  LeaderboardEntry,
  PlayerGameStateView,
  PlayerLobbyEntry,
  PlayerScorecard,
} from "./types.js";
import { ID_SCHEMA, JOIN_CODE_SCHEMA } from "./constants.js";

/** Optional idempotency key for host commands. Same runId + same command => no-op. */
export const RUN_ID = z.string().min(8).max(64).optional();

export const PlayerSyncEvent = z.object({});
export type PlayerSyncEvent = z.infer<typeof PlayerSyncEvent>;

export const PlayerHeartbeatEvent = z.object({});
export type PlayerHeartbeatEvent = z.infer<typeof PlayerHeartbeatEvent>;

export const PlayerSetAnswerEvent = z.object({
  gameId: ID_SCHEMA,
  questionId: ID_SCHEMA,
  optionId: ID_SCHEMA,
});
export type PlayerSetAnswerEvent = z.infer<typeof PlayerSetAnswerEvent>;

export const PlayerMarkReviewEvent = z.object({
  gameId: ID_SCHEMA,
  questionId: ID_SCHEMA,
  marked: z.boolean(),
});
export type PlayerMarkReviewEvent = z.infer<typeof PlayerMarkReviewEvent>;

export const PlayerSubmitPaperEvent = z.object({
  gameId: ID_SCHEMA,
});
export type PlayerSubmitPaperEvent = z.infer<typeof PlayerSubmitPaperEvent>;

export const HostStartPaperEvent = z.object({
  gameId: ID_SCHEMA,
  runId: RUN_ID,
});
export type HostStartPaperEvent = z.infer<typeof HostStartPaperEvent>;

export const HostEndPaperEvent = z.object({
  gameId: ID_SCHEMA,
  runId: RUN_ID,
});
export type HostEndPaperEvent = z.infer<typeof HostEndPaperEvent>;

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
  "player:sync": PlayerSyncEvent,
  "player:heartbeat": PlayerHeartbeatEvent,
  "player:set-answer": PlayerSetAnswerEvent,
  "player:mark-review": PlayerMarkReviewEvent,
  "player:submit-paper": PlayerSubmitPaperEvent,
  "host:start-paper": HostStartPaperEvent,
  "host:end-paper": HostEndPaperEvent,
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

export const PlayerSetAnswerAckEvent = z.object({
  questionId: ID_SCHEMA,
  optionId: ID_SCHEMA,
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type PlayerSetAnswerAckEvent = z.infer<typeof PlayerSetAnswerAckEvent>;

export const GameFinishedEvent = z.object({
  gameId: ID_SCHEMA,
  joinCode: JOIN_CODE_SCHEMA,
  quizTitle: z.string(),
  leaderboard: z.array(LeaderboardEntry),
});
export type GameFinishedEvent = z.infer<typeof GameFinishedEvent>;

export const HostPaperStartedEvent = z.object({
  gameId: ID_SCHEMA,
  timeLimitSeconds: z.number().int().positive(),
  paperStartedAt: z.number().int().positive(),
  deadline: z.number().int().positive(),
});
export type HostPaperStartedEvent = z.infer<typeof HostPaperStartedEvent>;

export const HostPlayerSubmittedEvent = z.object({
  playerId: ID_SCHEMA,
  nickname: z.string().min(1).max(24),
  submittedCount: z.number().int().min(0),
});
export type HostPlayerSubmittedEvent = z.infer<typeof HostPlayerSubmittedEvent>;

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
  "player:set-answer-ack": PlayerSetAnswerAckEvent,
  "player:scorecard": PlayerScorecard,
  "game:finished": GameFinishedEvent,
  "host:state": HostGameStateView,
  "host:paper-started": HostPaperStartedEvent,
  "host:player-updated": PlayerLobbyEntry,
  "host:player-submitted": HostPlayerSubmittedEvent,
  "host:game-finished": HostGameFinishedEvent,
  "error": SocketErrorEvent,
} as const;

export type ServerEventName = keyof typeof SERVER_EVENTS;
export type ServerEventPayload<T extends ServerEventName> = z.infer<
  (typeof SERVER_EVENTS)[T]
>;

/** Typed Socket.IO wire contract: server -> client. */
export type ServerToClientEvents = {
  [K in ServerEventName]: (payload: ServerEventPayload<K>) => void;
};

/** Typed Socket.IO wire contract: client -> server. */
export type ClientToServerEvents = {
  [K in ClientEventName]: (payload: ClientEventPayload<K>) => void;
};