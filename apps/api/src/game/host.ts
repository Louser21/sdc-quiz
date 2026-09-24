import type { GameStateRow, QuestionSnapshot, QuestionCount } from "./store.js";
import * as store from "./store.js";
import { errors } from "../errors/index.js";
import { getLeaderboard } from "../leaderboard/index.js";
import {
  persistFinalResultsBackground,
  persistQuestionResultsBackground,
} from "../answers/service.js";
import type { HostQuestionResultEvent } from "@quiz/shared";

export interface StartQuestionOutcome {
  state: GameStateRow;
  question: QuestionSnapshot;
}

/** Start the next question. Strict ordering: only `questions[questionNumber]` may start. */
export async function startQuestion(
  gameId: string,
  hostUserId: string,
  questionId: string,
): Promise<StartQuestionOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.hostUserId !== hostUserId) throw errors.forbidden("Not the host of this game");
  if (state.phase !== "LOBBY" && state.phase !== "QUESTION_RESULTS") {
    throw errors.invalidTransition("Questions can only start from the lobby or after results");
  }
  const questions = await store.getOrderedQuestions(gameId);
  const nextIndex = state.questionNumber; // 0-based index of the next question to start
  const next = questions[nextIndex];
  if (!next) throw errors.invalidTransition("No more questions to start");
  if (next.id !== questionId) {
    throw errors.invalidTransition("Only the next question in sequence can be started");
  }
  const newState = await store.startQuestion(gameId, next, nextIndex + 1, questions.length);
  return { state: newState, question: next };
}

export interface EndQuestionOutcome {
  result: HostQuestionResultEvent;
  answers: store.StoredAnswer[];
}

/** End the active question (not ownership-checked — callers enforce host identity). */
export async function endActiveQuestion(gameId: string): Promise<EndQuestionOutcome> {
  const result = await store.endQuestion(gameId);
  const answers = await store.getAnswersForQuestion(gameId, result.questionId);
  const players = await store.getPlayers(gameId);
  const scores = new Map(Object.entries(players).map(([id, r]) => [id, r.score]));
  const nicknames = new Map(Object.entries(players).map(([id, r]) => [id, r.nickname]));
  const leaderboard = await getLeaderboard(gameId, nicknames);

  persistQuestionResultsBackground({
    gameId,
    questionId: result.questionId,
    correctOptionId: result.correctOptionId,
    answers,
    scores,
  });

  return {
    result: {
      questionId: result.questionId,
      correctOptionId: result.correctOptionId,
      optionCounts: result.optionCounts.map((c) => ({ optionId: c.optionId, count: c.count })),
      answerCount: result.answerCount,
      leaderboard,
    },
    answers,
  };
}

export async function endQuestion(gameId: string, hostUserId: string): Promise<EndQuestionOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.hostUserId !== hostUserId) throw errors.forbidden("Not the host of this game");
  return endActiveQuestion(gameId);
}

/** Find the next question id after the current state, if any. */
export async function nextQuestionId(gameId: string): Promise<string | null> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  const questions = await store.getOrderedQuestions(gameId);
  return questions[state.questionNumber]?.id ?? null;
}

export interface FinishGameOutcome {
  leaderboard: Awaited<ReturnType<typeof getLeaderboard>>;
  quizTitle: string;
  joinCode: string;
}

export async function finishGame(gameId: string, hostUserId: string): Promise<FinishGameOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.hostUserId !== hostUserId) throw errors.forbidden("Not the host of this game");
  await store.finishGame(gameId);
  const players = await store.getPlayers(gameId);
  const scores = new Map(Object.entries(players).map(([id, r]) => [id, r.score]));
  const nicknames = new Map(Object.entries(players).map(([id, r]) => [id, r.nickname]));
  const leaderboard = await getLeaderboard(gameId, nicknames);

  persistFinalResultsBackground(gameId, scores);

  // Persist the session lifecycle to Postgres (best-effort; Redis is authoritative).
  void (async () => {
    try {
      const { prisma } = await import("../db/client.js");
      await prisma.gameSession.update({
        where: { id: gameId },
        data: { status: "FINISHED", endedAt: new Date() },
      });
    } catch (err) {
      (await import("../logging/logger.js")).getLogger().warn(
        { gameId, err: err instanceof Error ? err.message : String(err) },
        "failed to persist finished session",
      );
    }
  })();

  return { leaderboard, quizTitle: state.quizTitle, joinCode: state.joinCode };
}

export type { QuestionCount };