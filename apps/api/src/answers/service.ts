import type { StoredAnswer } from "../game/store.js";
import { prisma } from "../db/client.js";
import { getLogger } from "../logging/logger.js";

/**
 * Background PostgreSQL persistence for live-game results.
 * Gameplay never blocks on these writes — they run after the question ends /
 * game finishes and are logged on failure (never silently swallowed).
 */

export async function persistQuestionResults(data: {
  gameId: string;
  questionId: string;
  correctOptionId: string;
  answers: StoredAnswer[];
  scores: Map<string, number>;
}): Promise<void> {
  const rows = data.answers.map((a) => ({
    gameId: data.gameId,
    questionId: data.questionId,
    playerId: a.playerId,
    optionId: a.optionId,
    isCorrect: a.optionId === data.correctOptionId,
    points: a.points,
    submittedAt: new Date(a.ts),
  }));
  if (rows.length > 0) {
    await prisma.answer.createMany({
      data: rows,
      skipDuplicates: true, // (gameId, playerId, questionId) unique — idempotent retries
    });
  }
  await syncScores(data.gameId, data.scores);
}

/** Keep PG player scores in sync with the authoritative Redis scores (diffs only). */
export async function syncScores(
  gameId: string,
  scores: Map<string, number>,
): Promise<void> {
  const players = await prisma.player.findMany({
    where: { gameId },
    select: { id: true, score: true },
  });
  const updates = players
    .filter((p) => {
      const target = scores.get(p.id);
      return target !== undefined && target !== p.score;
    })
    .map((p) => prisma.player.update({ where: { id: p.id }, data: { score: scores.get(p.id)! } }));
  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }
}

export async function persistFinalResults(gameId: string, scores: Map<string, number>): Promise<void> {
  await prisma.gameSession.update({
    where: { id: gameId },
    data: { status: "FINISHED", endedAt: new Date() },
  });
  await syncScores(gameId, scores);
}

/** Fire-and-forget wrapper used by the socket layer: logs, never crashes. */
export function persistQuestionResultsBackground(data: Parameters<typeof persistQuestionResults>[0]): void {
  void persistQuestionResults(data).catch((err) => {
    getLogger().error({ err: err instanceof Error ? err.message : String(err), ...data }, "persist question results failed");
  });
}

export function persistFinalResultsBackground(gameId: string, scores: Map<string, number>): void {
  void persistFinalResults(gameId, scores).catch((err) => {
    getLogger().error({ err: err instanceof Error ? err.message : String(err), gameId }, "persist final results failed");
  });
}