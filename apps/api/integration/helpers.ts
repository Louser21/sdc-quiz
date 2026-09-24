import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import type { Server as IoServer } from "socket.io";
import { buildApp } from "../src/app.js";
import { attachSockets } from "../src/sockets/index.js";
import { setIo } from "../src/sockets/instance.js";

export const TEST_SESSION_COOKIE = "quiz_session";
export const TEST_PLAYER_COOKIE = "player_session";

export async function startTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/**
 * Boot a full app over a real TCP socket (port 0 = ephemeral) with Socket.IO
 * attached, for end-to-end game flows driven by socket.io-client.
 */
export async function startLiveServer(): Promise<{
  app: FastifyInstance;
  io: IoServer;
  base: string;
}> {
  const app = await buildApp();
  const io = attachSockets(app.server);
  setIo(io);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  return { app, io, base: `http://127.0.0.1:${addr.port}` };
}

/** Extract the raw session cookie value from a response's set-cookie header. */
export function extractSessionCookie(resp: LightMyRequestResponse): string {
  const setCookie = resp.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error("Response did not set a session cookie");
  const match = /quiz_session=([^;]+)/.exec(header);
  if (!match) throw new Error("quiz_session cookie not found in set-cookie");
  return match[1] ?? "";
}

export function withCookie(token: string): { cookies: Record<string, string> } {
  return { cookies: { [TEST_SESSION_COOKIE]: token } };
}

export async function registerUser(
  app: FastifyInstance,
  overrides: Partial<{ email: string; name: string; password: string }> = {},
): Promise<{ token: string; user: { id: string; email: string; name: string; role: string } }> {
  const base = `test-${Math.random().toString(36).slice(2, 10)}`;
  const resp = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: overrides.email ?? `${base}@example.com`,
      name: overrides.name ?? "Tester",
      password: overrides.password ?? "password123",
    },
  });
  if (resp.statusCode !== 201) throw new Error(`register failed: ${resp.body}`);
  return { token: extractSessionCookie(resp), user: JSON.parse(resp.body).user };
}

/** Wipe all app tables. Call in beforeEach() when isolation is required. */
export async function resetDb(): Promise<void> {
  const { prisma } = await import("../src/db/client.js");
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Answer", "Player", "GameSession", "Quiz", "Question", "Option", "Session", "User" CASCADE;',
  );
}

/** Create a published quiz with N questions (each 2 options, first correct). */
export async function createPublishedQuiz(
  app: FastifyInstance,
  token: string,
  title = `Quiz ${Math.random().toString(36).slice(2, 8)}`,
  questionCount = 2,
  timeLimitSeconds = 600,
): Promise<{
  quizId: string;
  questions: { id: string; correctOptionId: string; wrongOptionId: string }[];
}> {
  const created = await app.inject({
    method: "POST",
    url: "/api/quizzes",
    payload: { title, description: "integration", timeLimitSeconds },
    ...withCookie(token),
  });
  const quizId = JSON.parse(created.body).quiz.id as string;
  for (let n = 0; n < questionCount; n++) {
    await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions`,
      payload: {
        text: `Q${n + 1}: pick the right one`,
        options: [
          { text: `correct-opt-${n}`, isCorrect: true },
          { text: `wrong-opt-${n}`, isCorrect: false },
        ],
      },
      ...withCookie(token),
    });
  }
  await app.inject({ method: "POST", url: `/api/quizzes/${quizId}/publish`, ...withCookie(token) });

  // Read back real option ids (questions carry isCorrect for the quiz owner).
  const detail = await app.inject({ method: "GET", url: `/api/quizzes/${quizId}`, ...withCookie(token) });
  const quiz = JSON.parse(detail.body).quiz as {
    questions: { id: string; options: { id: string; isCorrect: boolean }[] }[];
  };
  return {
    quizId,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      correctOptionId: q.options.find((o) => o.isCorrect)!.id,
      wrongOptionId: q.options.find((o) => !o.isCorrect)!.id,
    })),
  };
}

/** Join a game as a player through the REST endpoint; returns the player session cookie value. */
export async function joinPlayerAsCookie(
  app: FastifyInstance,
  joinCode: string,
  nickname: string,
): Promise<{ cookie: string; pair: { player_session: string }; body: { join: { gameId: string; joinCode: string; player: { playerId: string; nickname: string } } } }> {
  const resp = await app.inject({
    method: "POST",
    url: "/api/play/join",
    payload: { gameCode: joinCode, nickname },
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 201) {
    throw new Error(`join failed ${resp.statusCode}: ${resp.body}`);
  }
  const setCookie = resp.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = new RegExp(`${TEST_PLAYER_COOKIE}=([^;]+)`).exec(header ?? "");
  if (!match) throw new Error("player_session cookie not set");
  return {
    cookie: `${TEST_PLAYER_COOKIE}=${match[1]}`,
    pair: { player_session: match[1]! },
    body: JSON.parse(resp.body),
  };
}