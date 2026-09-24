import type { PlayerScorecard } from "@quiz/shared";
import * as store from "./store.js";
import { errors } from "../errors/index.js";
import { scoreForCorrectness } from "../scoring/index.js";
import type { SubmittedPaper } from "../answers/service.js";
import { persistSubmittedPaperBackground } from "../answers/service.js";

/**
 * Participant-facing paper operations. All mutations are re-validated
 * atomically in the Lua store scripts (phase, deadline, submitted-lock) so a
 * selection change or double-submit can never succeed after the paper locks.
 */

function assertOptionBelongsToQuestion(
  questions: store.QuestionsSnapshot,
  questionId: string,
  optionId: string,
): void {
  const question = questions.list.find((q) => q.id === questionId);
  if (!question) throw errors.invalidOption("Unknown question");
  if (!question.options.some((o) => o.id === optionId)) {
    throw errors.invalidOption("Option does not belong to this question");
  }
}

export async function setAnswer(
  gameId: string,
  playerId: string,
  questionId: string,
  optionId: string,
): Promise<void> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.phase !== "ACTIVE") throw errors.paperNotActive();
  const questions = await store.getQuestions(gameId);
  assertOptionBelongsToQuestion(questions, questionId, optionId);
  await store.setAnswer(gameId, playerId, questionId, optionId, Date.now());
}

export async function setMarked(
  gameId: string,
  playerId: string,
  questionId: string,
  marked: boolean,
): Promise<void> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.phase !== "ACTIVE") throw errors.paperNotActive();
  const questions = await store.getQuestions(gameId);
  if (!questions.list.some((q) => q.id === questionId)) {
    throw errors.invalidOption("Unknown question");
  }
  await store.setMarked(gameId, playerId, questionId, marked, Date.now());
}

export interface SubmitOutcome {
  alreadySubmitted: boolean;
  scorecard: PlayerScorecard;
}

/**
 * Submit the player's current selections. Server-authoritative: Lua locks the
 * submission atomically; a retry after a successful submit is a harmless
 * no-op returning the same scorecard. The player's score is computed here
 * (never provided by the client) and mirrored to the leaderboard.
 */
export async function submitPaper(gameId: string, playerId: string): Promise<SubmitOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.phase !== "ACTIVE") throw errors.paperNotActive();

  const now = Date.now();
  const { alreadySubmitted, submittedAt } = await store.submitPaper(gameId, playerId, now);

  const questions = await store.getQuestions(gameId);
  const record = await store.getPlayer(gameId, playerId);
  const paper: SubmittedPaper = { gameId, playerId, submittedAt, rows: [] };

  let score = 0;
  let correctCount = 0;
  const selections = await store.getSelections(gameId, playerId);
  for (const [questionId, optionId] of Object.entries(selections)) {
    const correct = questions.correct[questionId] === optionId;
    const points = scoreForCorrectness(correct);
    if (correct) correctCount += 1;
    score += points;
    paper.rows.push({ questionId, optionId, isCorrect: correct, points });
  }

  await store.setPlayerScore(gameId, playerId, score);
  persistSubmittedPaperBackground(paper);

  return {
    alreadySubmitted,
    scorecard: {
      submitted: true,
      submittedAt: record?.submittedAt ?? submittedAt,
      correctCount,
      totalQuestions: questions.list.length,
      score,
    },
  };
}