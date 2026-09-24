import type { GameStateRow } from "./store.js";
import * as store from "./store.js";
import { errors } from "../errors/index.js";
import { scoreForCorrectness } from "../scoring/index.js";
import type { SubmittedPaper } from "../answers/service.js";
import {
  persistFinalResultsBackground,
  persistSubmittedPaperBackground,
} from "../answers/service.js";

export interface StartPaperOutcome {
  state: GameStateRow;
}

/** Start the paper. LOBBY -> ACTIVE with a server-computed deadline. */
export async function startPaper(
  gameId: string,
  hostUserId: string,
): Promise<StartPaperOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.hostUserId !== hostUserId) throw errors.forbidden("Not the host of this game");
  if (state.phase !== "LOBBY") {
    throw errors.invalidTransition("The paper can only start from the lobby");
  }
  const now = Date.now();
  const deadline = now + state.timeLimitSeconds * 1000;
  const next = await store.startPaper(gameId, now, deadline);
  return { state: next };
}

export interface FinalizePaperOutcome {
  leaderboard: { playerId: string; nickname: string; score: number }[];
  quizTitle: string;
  joinCode: string;
  papers: SubmittedPaper[];
}

/**
 * End the paper for every player: auto-submit any outstanding selections,
 * compute authoritative scores, and flip the game to FINISHED. Not
 * ownership-checked — callers (host command or the deadline timer) enforce
 * their own authority. Idempotent once FINISHED.
 */
export async function finalizePaper(gameId: string): Promise<FinalizePaperOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.phase === "FINISHED") {
    const players = await store.getPlayers(gameId);
    return {
      leaderboard: store.toLeaderboardEntries(players),
      quizTitle: state.quizTitle,
      joinCode: state.joinCode,
      papers: [],
    };
  }
  if (state.phase !== "ACTIVE") {
    throw errors.paperNotActive("The paper is not active");
  }

  const now = Date.now();
  await store.autoSubmitRemaining(gameId, now);

  const players = await store.getPlayers(gameId);
  const questions = await store.getQuestions(gameId);
  const papers: SubmittedPaper[] = [];
  const scores = new Map<string, number>();

  for (const [playerId, record] of Object.entries(players)) {
    if (!record.submitted) continue;
    const selections = await store.getSelections(gameId, playerId);
    const rows = Object.entries(selections).map(([questionId, optionId]) => {
      const correct = questions.correct[questionId] === optionId;
      return {
        questionId,
        optionId,
        isCorrect: correct,
        points: scoreForCorrectness(correct),
      };
    });
    const score = rows.reduce((s, r) => s + r.points, 0);
    await store.setPlayerScore(gameId, playerId, score);
    scores.set(playerId, score);
    papers.push({
      gameId,
      playerId,
      submittedAt: record.submittedAt ?? now,
      rows,
    });
  }

  await store.finishGame(gameId);

  for (const paper of papers) persistSubmittedPaperBackground(paper);
  persistFinalResultsBackground(gameId, scores);

  // Re-fetch AFTER persisting every score so auto-submitted players appear
  // with the points they earned, not the pre-finalize zeros.
  const finalPlayers = await store.getPlayers(gameId);

  return {
    leaderboard: store.toLeaderboardEntries(finalPlayers),
    quizTitle: state.quizTitle,
    joinCode: state.joinCode,
    papers,
  };
}

/** Host-requested early end: same finalize path, gated to ACTIVE. */
export async function endPaper(
  gameId: string,
  hostUserId: string,
): Promise<FinalizePaperOutcome> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  if (state.hostUserId !== hostUserId) throw errors.forbidden("Not the host of this game");
  if (state.phase === "FINISHED") {
    throw errors.gameFinished("That paper has already finished");
  }
  return finalizePaper(gameId);
}

/** Find whether the game can still accept a fresh start command (used by guard rails). */
export async function canStartPaper(gameId: string): Promise<boolean> {
  const state = await store.getState(gameId);
  return state !== null && state.phase === "LOBBY";
}