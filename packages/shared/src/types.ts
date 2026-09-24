import { z } from "zod";
import { GAME_PHASES, ID_SCHEMA, JOIN_CODE_SCHEMA } from "./constants.js";

export const GamePhaseSchema = z.enum(GAME_PHASES);

export const OptionView = z.object({
  id: ID_SCHEMA,
  text: z.string().min(1).max(500),
});

/**
 * What a player sees when a question starts. NEVER contains correctness info.
 */
export const QuestionPayload = z.object({
  questionId: ID_SCHEMA,
  questionNumber: z.number().int().min(1),
  totalQuestions: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  options: z.array(OptionView).min(2).max(10),
  timeLimit: z.number().int().min(3).max(600),
  questionEndsAt: z.number().int().positive(),
});
export type QuestionPayload = z.infer<typeof QuestionPayload>;

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
});
export type PlayerLobbyEntry = z.infer<typeof PlayerLobbyEntry>;

const PlayerQuestionView = QuestionPayload.extend({
  alreadyAnswered: z.boolean(),
  selectedOptionId: ID_SCHEMA.nullable(),
});

export const PlayerQuestionResult = z.object({
  questionId: ID_SCHEMA,
  correctOptionId: ID_SCHEMA,
  selectedOptionId: ID_SCHEMA.nullable(),
  points: z.number().int(),
  isCorrect: z.boolean(),
  totalPoints: z.number().int(),
});
export type PlayerQuestionResult = z.infer<typeof PlayerQuestionResult>;

export const PlayerGameStateView = z.object({
  gameId: ID_SCHEMA,
  joinCode: JOIN_CODE_SCHEMA,
  phase: GamePhaseSchema,
  hostPresent: z.boolean(),
  player: z.object({
    playerId: ID_SCHEMA,
    nickname: z.string().min(1).max(24),
    totalPoints: z.number().int(),
  }),
  currentQuestion: PlayerQuestionView.nullable(),
  questionResult: PlayerQuestionResult.nullable(),
  leaderboard: z.array(LeaderboardEntry).nullable(),
});
export type PlayerGameStateView = z.infer<typeof PlayerGameStateView>;

export const HostQuestionView = z.object({
  questionId: ID_SCHEMA,
  questionNumber: z.number().int().min(1),
  totalQuestions: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  timeLimit: z.number().int().min(3).max(600),
  questionStartedAt: z.number().int().positive(),
  questionEndsAt: z.number().int().positive(),
  answerCount: z.number().int().min(0),
});
export type HostQuestionView = z.infer<typeof HostQuestionView>;

export const HostQuestionResult = z.object({
  questionId: ID_SCHEMA,
  correctOptionId: ID_SCHEMA,
  optionCounts: z.array(z.object({ optionId: ID_SCHEMA, count: z.number().int() })),
  answerCount: z.number().int(),
});
export type HostQuestionResult = z.infer<typeof HostQuestionResult>;

export const HostGameStateView = z.object({
  gameId: ID_SCHEMA,
  joinCode: JOIN_CODE_SCHEMA,
  phase: GamePhaseSchema,
  quizTitle: z.string(),
  players: z.array(PlayerLobbyEntry),
  currentQuestion: HostQuestionView.nullable(),
  questionResult: HostQuestionResult.nullable(),
  leaderboard: z.array(LeaderboardEntry),
});
export type HostGameStateView = z.infer<typeof HostGameStateView>;