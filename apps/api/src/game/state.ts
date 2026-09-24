import type {
  HostGameStateView,
  HostQuestionResult,
  HostQuestionView,
  LeaderboardEntry,
  PlayerGameStateView,
  PlayerQuestionResult,
  PlayerLobbyEntry,
} from "@quiz/shared";
import * as store from "./store.js";
import { errors } from "../errors/index.js";
import { getLeaderboard } from "../leaderboard/index.js";

/**
 * Server-side view builders. These produce exactly what clients are ALLOWED to
 * see — correctness is resolved server-side and option payloads never carry it.
 */

function nicknameMap(players: Record<string, store.PlayerRecord>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [id, p] of Object.entries(players)) map.set(id, p.nickname);
  return map;
}

function buildLobbyEntries(players: Record<string, store.PlayerRecord>): PlayerLobbyEntry[] {
  return Object.entries(players)
    .map(([playerId, p]) => ({ playerId, nickname: p.nickname, connected: p.connected }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
}

async function buildCurrentQuestion(
  state: store.GameStateRow,
  question: store.QuestionSnapshot,
  playerId: string,
): Promise<PlayerGameStateView["currentQuestion"]> {
  if (state.phase !== "QUESTION_ACTIVE" || !state.currentQuestionId || !state.questionEndsAt) {
    return null;
  }
  const answer = await store.getPlayerAnswerForQuestion(state.gameId, playerId, question.id);
  return {
    questionId: question.id,
    questionNumber: state.questionNumber,
    totalQuestions: state.totalQuestions,
    text: question.text,
    options: question.options.map((o) => ({ id: o.id, text: o.text })),
    timeLimit: question.timeLimit,
    questionEndsAt: state.questionEndsAt,
    alreadyAnswered: answer !== null,
    selectedOptionId: answer?.optionId ?? null,
  };
}

async function buildPlayerResult(
  state: store.GameStateRow,
  playerId: string,
  currentScore: number,
): Promise<PlayerQuestionResult | null> {
  if (!state.resultQuestionId || !state.correctOptionId) return null;
  const questionId = state.resultQuestionId;
  const answer = await store.getPlayerAnswerForQuestion(state.gameId, playerId, questionId);
  return {
    questionId,
    correctOptionId: state.correctOptionId,
    selectedOptionId: answer?.optionId ?? null,
    points: answer?.points ?? 0,
    isCorrect: answer !== null && answer.optionId === state.correctOptionId,
    totalPoints: currentScore,
  };
}

export async function buildPlayerState(gameId: string, playerId: string): Promise<PlayerGameStateView> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  const players = await store.getPlayers(gameId);
  const record = players[playerId];
  if (!record) throw errors.invalidSession("Player session no longer valid for this game");

  const questions = await store.getQuestions(gameId);
  const current = state.currentQuestionId
    ? questions.list.find((q) => q.id === state.currentQuestionId) ?? null
    : null;

  const currentQuestion =
    current && state.phase === "QUESTION_ACTIVE"
      ? await buildCurrentQuestion(state, current, playerId)
      : null;

  const questionResult =
    state.phase === "QUESTION_RESULTS" || state.phase === "FINISHED"
      ? await buildPlayerResult(state, playerId, record.score)
      : null;

  const leaderboard: LeaderboardEntry[] | null =
    state.phase === "FINISHED" ? await getLeaderboard(gameId, nicknameMap(players)) : null;

  return {
    gameId,
    joinCode: state.joinCode,
    phase: state.phase as PlayerGameStateView["phase"],
    hostPresent: state.hostConnected,
    player: { playerId, nickname: record.nickname, totalPoints: record.score },
    currentQuestion,
    questionResult,
    leaderboard,
  };
}

function buildHostQuestionView(
  state: store.GameStateRow,
  question: store.QuestionSnapshot | undefined,
): HostQuestionView | null {
  if (state.phase !== "QUESTION_ACTIVE" || !state.currentQuestionId || !question) return null;
  return {
    questionId: state.currentQuestionId,
    questionNumber: state.questionNumber,
    totalQuestions: state.totalQuestions,
    text: question.text,
    timeLimit: question.timeLimit,
    questionStartedAt: state.questionStartedAt ?? 0,
    questionEndsAt: state.questionEndsAt ?? 0,
    answerCount: state.answerCount,
  };
}

async function buildHostQuestionResult(
  state: store.GameStateRow,
): Promise<HostQuestionResult | null> {
  if (!state.resultQuestionId || !state.correctOptionId) return null;
  const counts = await store.getCounts(state.gameId, state.resultQuestionId);
  return {
    questionId: state.resultQuestionId,
    correctOptionId: state.correctOptionId,
    optionCounts: counts.map((c) => ({ optionId: c.optionId, count: c.count })),
    answerCount: state.answerCount,
  };
}

export async function buildHostState(gameId: string): Promise<HostGameStateView> {
  const state = await store.getState(gameId);
  if (!state) throw errors.invalidGameCode("Game is not available");
  const players = await store.getPlayers(gameId);
  const questions = await store.getQuestions(gameId);
  const current = state.currentQuestionId
    ? questions.list.find((q) => q.id === state.currentQuestionId)
    : undefined;

  return {
    gameId,
    joinCode: state.joinCode,
    phase: state.phase as HostGameStateView["phase"],
    quizTitle: state.quizTitle,
    players: buildLobbyEntries(players),
    currentQuestion: buildHostQuestionView(state, current),
    questionResult: await buildHostQuestionResult(state),
    leaderboard: await getLeaderboard(gameId, nicknameMap(players)),
  };
}