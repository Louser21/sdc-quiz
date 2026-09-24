import type {
  HostGameStateView,
  LeaderboardEntry,
  PlayerGameStateView,
  PlayerLobbyEntry,
  PlayerScorecard,
} from "@quiz/shared";
import * as store from "./store.js";
import { errors } from "../errors/index.js";

/**
 * Server-side view builders. These produce exactly what clients are ALLOWED to
 * see — correctness is resolved server-side at submit time and question
 * payloads never carry it.
 */

function buildLobbyEntries(players: Record<string, store.PlayerRecord>): PlayerLobbyEntry[] {
  return Object.entries(players)
    .map(([playerId, p]) => ({
      playerId,
      nickname: p.nickname,
      connected: p.connected,
      submitted: p.submitted,
    }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
}

function buildPaperQuestions(
  state: store.GameStateRow,
  questions: store.QuestionsSnapshot,
): PlayerGameStateView["questions"] {
  const total = questions.list.length;
  return questions.list.map((q) => ({
    questionId: q.id,
    questionNumber: questions.list.findIndex((item) => item.id === q.id) + 1,
    totalQuestions: total,
    text: q.text,
    options: q.options.map((o) => ({ id: o.id, text: o.text })),
  }));
}

function buildScorecard(
  state: store.GameStateRow,
  record: store.PlayerRecord,
  questions: store.QuestionsSnapshot,
  selections: Record<string, string>,
): PlayerScorecard | null {
  if (!record.submitted) return null;
  let correctCount = 0;
  for (const [questionId, optionId] of Object.entries(selections)) {
    if (questions.correct[questionId] === optionId) correctCount += 1;
  }
  return {
    submitted: true,
    submittedAt: record.submittedAt ?? Date.now(),
    correctCount,
    totalQuestions: questions.list.length,
    score: record.score,
  };
}

export async function buildPlayerState(gameId: string, playerId: string): Promise<PlayerGameStateView> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  const record = await store.getPlayer(gameId, playerId);
  if (!record) throw errors.invalidSession("Player session no longer valid for this game");

  const [questions, selections, marked] = await Promise.all([
    store.getQuestions(gameId),
    store.getSelections(gameId, playerId),
    store.getMarked(gameId, playerId),
  ]);

  const players = await store.getPlayers(gameId);
  const leaderboard: LeaderboardEntry[] | null =
    state.phase === "FINISHED" ? store.toLeaderboardEntries(players) : null;

  return {
    gameId,
    joinCode: state.joinCode,
    quizTitle: state.quizTitle,
    phase: state.phase as PlayerGameStateView["phase"],
    hostPresent: state.hostConnected,
    timeLimitSeconds: state.timeLimitSeconds,
    paperStartedAt: state.paperStartedAt,
    deadline: state.deadline,
    player: { playerId, nickname: record.nickname, submitted: record.submitted },
    questions: buildPaperQuestions(state, questions),
    selections,
    marked,
    scorecard: buildScorecard(state, record, questions, selections),
    leaderboard,
  };
}

export async function buildHostState(gameId: string): Promise<HostGameStateView> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  const players = await store.getPlayers(gameId);
  const submittedCount = Object.values(players).filter((p) => p.submitted).length;

  return {
    gameId,
    joinCode: state.joinCode,
    phase: state.phase as HostGameStateView["phase"],
    quizTitle: state.quizTitle,
    timeLimitSeconds: state.timeLimitSeconds,
    paperStartedAt: state.paperStartedAt,
    deadline: state.deadline,
    players: buildLobbyEntries(players),
    submittedCount,
    leaderboard: store.toLeaderboardEntries(players),
  };
}