import { prisma } from "../db/client.js";
import { getLogger } from "../logging/logger.js";

/**
 * Background PostgreSQL persistence for CBT-paper results.
 * Gameplay never blocks on these writes — they run after a paper is submitted
 * (voluntarily or at the deadline) and are logged on failure (never silently
 * swallowed). Redis remains the authoritative live state.
 */

export interface SubmittedPaperRow {
  questionId: string;
  optionId: string;
  isCorrect: boolean;
  points: number;
}

export interface SubmittedPaper {
  gameId: string;
  playerId: string;
  submittedAt: number;
  rows: SubmittedPaperRow[];
}

/** Persist one submitted paper: answer rows + the player's final score. */
export async function persistSubmittedPaper(paper: SubmittedPaper): Promise<void> {
  const answerRows = paper.rows.map((r) => ({
    gameId: paper.gameId,
    questionId: r.questionId,
    playerId: paper.playerId,
    optionId: r.optionId,
    isCorrect: r.isCorrect,
    points: r.points,
    submittedAt: new Date(paper.submittedAt),
  }));
  const score = paper.rows.reduce((s, r) => s + r.points, 0);

  if (answerRows.length > 0) {
    await prisma.answer.createMany({
      data: answerRows,
      skipDuplicates: true, // (gameId, playerId, questionId) unique — idempotent retries
    });
  }
  await prisma.player.update({
    where: { id: paper.playerId },
    data: { score },
  });
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
export function persistSubmittedPaperBackground(paper: SubmittedPaper): void {
  void persistSubmittedPaper(paper).catch((err) => {
    getLogger().error(
      { err: err instanceof Error ? err.message : String(err), gameId: paper.gameId, playerId: paper.playerId },
      "persist submitted paper failed",
    );
  });
}

export function persistFinalResultsBackground(gameId: string, scores: Map<string, number>): void {
  void persistFinalResults(gameId, scores).catch((err) => {
    getLogger().error({ err: err instanceof Error ? err.message : String(err), gameId }, "persist final results failed");
  });
}