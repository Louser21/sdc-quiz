import type { GameSessionSummaryDto } from "@quiz/shared";
import { prisma } from "../db/client.js";
import { AppError } from "../errors/index.js";
import { createUniqueJoinCode } from "../game/join-code.js";
import * as store from "../game/store.js";

function toSummary(
  s: {
    id: string;
    quizId: string;
    quiz: { title: string };
    joinCode: string;
    status: string;
    createdAt: Date;
    _count?: { players?: number };
  },
  playerCount?: number,
): GameSessionSummaryDto {
  return {
    id: s.id,
    quizId: s.quizId,
    quizTitle: s.quiz.title,
    joinCode: s.joinCode,
    status: s.status as GameSessionSummaryDto["status"],
    playerCount: playerCount ?? s._count?.players ?? 0,
    createdAt: s.createdAt.toISOString(),
  };
}

export async function listGames(userId: string): Promise<GameSessionSummaryDto[]> {
  const sessions = await prisma.gameSession.findMany({
    where: { hostId: userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      quiz: { select: { title: true } },
      _count: { select: { players: true } },
    },
  });
  return Promise.all(
    sessions.map(async (s) => toSummary(s, await livePlayerCount(s))),
  );
}

/** Prefer the live (Redis) count; fall back to the persisted count. */
async function livePlayerCount(
  s: { id: string; status: string; _count?: { players?: number } },
): Promise<number> {
  if (s.status !== "ACTIVE") return s._count?.players ?? 0;
  try {
    return await store.playerCount(s.id);
  } catch {
    return s._count?.players ?? 0;
  }
}

export async function getGame(userId: string, gameId: string): Promise<GameSessionSummaryDto> {
  const session = await prisma.gameSession.findUnique({
    where: { id: gameId },
    include: { quiz: { select: { title: true } } },
  });
  if (!session) throw new AppError("NOT_FOUND", "Game session not found", 404);
  if (session.hostId !== userId) throw new AppError("FORBIDDEN", "Not your game session", 403);
  const players = session.status === "ACTIVE" ? await store.playerCount(session.id) : undefined;
  return toSummary(session, players);
}

/**
 * Create a live game session from a published quiz. Loads the full question
 * snapshot (with the server-private correct-answer map) into Redis — the live
 * state machine never reads correctness from the client or from Postgres for
 * answers beyond the snapshot.
 */
export async function createGame(
  userId: string,
  quizId: string,
): Promise<GameSessionSummaryDto> {
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: {
      questions: {
        orderBy: { position: "asc" },
        include: { options: { orderBy: { position: "asc" } } },
      },
    },
  });
  if (!quiz) throw new AppError("NOT_FOUND", "Quiz not found", 404);
  if (quiz.creatorId !== userId) throw new AppError("FORBIDDEN", "You do not own this quiz", 403);
  if (quiz.status !== "PUBLISHED") {
    throw new AppError("CONFLICT", "Only published quizzes can be played", 409);
  }
  if (quiz.questions.length === 0) {
    throw new AppError("CONFLICT", "This quiz has no questions", 409);
  }

  const joinCode = await createUniqueJoinCode();
  const session = await prisma.gameSession.create({
    data: {
      quizId: quiz.id,
      joinCode,
      hostId: userId,
      status: "ACTIVE",
      startedAt: new Date(),
    },
    include: { quiz: { select: { title: true } } },
  });

  const snapshot: store.QuestionsSnapshot = {
    list: quiz.questions.map((q) => ({
      id: q.id,
      text: q.text,
      options: q.options.map((o) => ({ id: o.id, text: o.text })),
    })),
    correct: Object.fromEntries(
      quiz.questions.map((q) => [
        q.id,
        q.options.find((o) => o.isCorrect)?.id ?? "", // validated 1:1 at write time
      ]),
    ),
  };

  await store.createGame(
    {
      gameId: session.id,
      joinCode: session.joinCode,
      quizId: quiz.id,
      quizTitle: quiz.title,
      hostUserId: userId,
      timeLimitSeconds: quiz.timeLimitSeconds,
    },
    snapshot,
  );

  return toSummary({ ...session, _count: { players: 0 } });
}