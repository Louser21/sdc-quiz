import { z } from "zod";
import { GAME_PHASES, ID_SCHEMA, JOIN_CODE_SCHEMA } from "./constants.js";

export const GamePhaseSchema = z.enum(GAME_PHASES);

export const OptionView = z.object({
  id: ID_SCHEMA,
  text: z.string().min(1).max(500),
});
export type OptionView = z.infer<typeof OptionView>;

/**
 * One question on the paper, as a participant sees it. NEVER contains
 * correctness info — the correct-answer map is server-private until a player
 * submits their paper.
 */
export const PaperQuestionView = z.object({
  questionId: ID_SCHEMA,
  questionNumber: z.number().int().min(1),
  totalQuestions: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  options: z.array(OptionView).min(2).max(10),
});
export type PaperQuestionView = z.infer<typeof PaperQuestionView>;

export const LeaderboardEntry = z.object({
  playerId: ID_SCHEMA,
  nickname: z.string().min(1).max(24),
  score: z.number().int(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

export const PlayerLobbyEntry = z.object({
  playerId: ID_SCHEMA,
  nickname: z.string().min(1).max(24),
  connected: z.boolean(),
  submitted: z.boolean().default(false),
});
export type PlayerLobbyEntry = z.infer<typeof PlayerLobbyEntry>;

export const PlayerScorecard = z.object({
  submitted: z.literal(true),
  submittedAt: z.number().int().positive(),
  correctCount: z.number().int().min(0),
  totalQuestions: z.number().int().min(0),
  score: z.number().int().min(0),
});
export type PlayerScorecard = z.infer<typeof PlayerScorecard>;

export const PlayerGameStateView = z.object({
  gameId: ID_SCHEMA,
  joinCode: JOIN_CODE_SCHEMA,
  quizTitle: z.string(),
  phase: GamePhaseSchema,
  hostPresent: z.boolean(),
  timeLimitSeconds: z.number().int().positive(),
  paperStartedAt: z.number().int().positive().nullable(),
  deadline: z.number().int().positive().nullable(),
  player: z.object({
    playerId: ID_SCHEMA,
    nickname: z.string().min(1).max(24),
    submitted: z.boolean(),
  }),
  questions: z.array(PaperQuestionView),
  selections: z.record(z.string(), ID_SCHEMA),
  marked: z.record(z.string(), z.boolean()),
  scorecard: PlayerScorecard.nullable(),
  leaderboard: z.array(LeaderboardEntry).nullable(),
});
export type PlayerGameStateView = z.infer<typeof PlayerGameStateView>;

export const HostGameStateView = z.object({
  gameId: ID_SCHEMA,
  joinCode: JOIN_CODE_SCHEMA,
  phase: GamePhaseSchema,
  quizTitle: z.string(),
  timeLimitSeconds: z.number().int().positive(),
  paperStartedAt: z.number().int().positive().nullable(),
  deadline: z.number().int().positive().nullable(),
  players: z.array(PlayerLobbyEntry),
  submittedCount: z.number().int().min(0),
  leaderboard: z.array(LeaderboardEntry),
});
export type HostGameStateView = z.infer<typeof HostGameStateView>;