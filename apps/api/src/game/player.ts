import * as store from "./store.js";
import { errors } from "../errors/index.js";
import { calculateScore } from "../scoring/index.js";

export interface SubmitOutcome {
  accepted: true;
  points: number;
  isCorrect: boolean;
  answerCount: number;
  questionId: string;
}

/**
 * Server-authoritative answer submission. The Lua store script re-validates the
 * phase, question, deadline, and duplicate state atomically — a second call for
 * the same (player, question) can never succeed, even under concurrent retries.
 */
export async function submitAnswer(
  gameId: string,
  playerId: string,
  questionId: string,
  optionId: string,
): Promise<SubmitOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.phase !== "QUESTION_ACTIVE") throw errors.questionNotActive();
  if (state.currentQuestionId !== questionId) throw errors.questionNotActive("That question is not active");

  const questions = await store.getQuestions(gameId);
  const question = questions.list.find((q) => q.id === questionId);
  if (!question) throw errors.questionNotActive("Unknown question");

  const validOption = question.options.some((o) => o.id === optionId);
  if (!validOption) throw errors.invalidOption();

  const now = Date.now();
  const correct = questions.correct[questionId] === optionId;
  const points = calculateScore(
    {
      timeLimit: question.timeLimit,
      startedAt: state.questionStartedAt ?? now,
      endsAt: state.questionEndsAt ?? now,
      now,
    },
    correct,
  );

  const { answerCount } = await store.submitAnswer(gameId, playerId, questionId, optionId, points);
  await store.addPlayerScore(gameId, playerId, points);

  return { accepted: true, points, isCorrect: correct, answerCount, questionId };
}