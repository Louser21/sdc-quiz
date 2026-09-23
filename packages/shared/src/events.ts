import { z } from "zod";
import { ID_SCHEMA, JOIN_CODE_SCHEMA, NICKNAME_SCHEMA } from "./constants.js";

/** Optional idempotency key for host commands. Same runId + same command => no-op. */
const RUN_ID = z.string().min(8).max(64).optional();

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
  "host:sync": HostSyncEvent,
} as const;

export type ClientEventName = keyof typeof CLIENT_EVENTS;
export type ClientEventPayload<T extends ClientEventName> = z.infer<
  (typeof CLIENT_EVENTS)[T]
>;