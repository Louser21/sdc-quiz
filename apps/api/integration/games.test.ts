import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioc, type Socket } from "socket.io-client";
import type { FastifyInstance } from "fastify";
import {
  createPublishedQuiz,
  joinPlayerAsCookie,
  registerUser,
  resetDb,
  startLiveServer,
  withCookie,
} from "./helpers.js";

let ctx: Awaited<ReturnType<typeof startLiveServer>>;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await startLiveServer();
  app = ctx.app;
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  ctx.io.close();
  await app.close();
});

function waitFor<T>(socket: Socket, event: string, timeout = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload: T) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Games + play REST
// ---------------------------------------------------------------------------

describe("games REST", () => {
  it("only creates a game from a published quiz, then lists/gets it", async () => {
    const { token } = await registerUser(app);
    const { quizId } = await createPublishedQuiz(app, token, "REST quiz", 1, 10);

    // Draft quiz rejected
    const draft = await app.inject({ method: "POST", url: "/api/games", payload: { quizId: "00000000-0000-4000-8000-000000000000" }, ...withCookie(token) });
    expect(draft.statusCode).toBe(404);

    const created = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: { quizId },
      ...withCookie(token),
    });
    expect(created.statusCode).toBe(201);
    const game = JSON.parse(created.body).game;
    expect(game.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(game.quizTitle).toBe("REST quiz");
    expect(game.playerCount).toBe(0);

    const list = await app.inject({ method: "GET", url: "/api/games", ...withCookie(token) });
    const games = JSON.parse(list.body).games;
    expect(games.map((g: { id: string }) => g.id)).toContain(game.id);

    const detail = await app.inject({ method: "GET", url: `/api/games/${game.id}`, ...withCookie(token) });
    expect(detail.statusCode).toBe(200);

    // Another host must not see it
    const other = await registerUser(app);
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/games/${game.id}`,
      ...withCookie(other.token),
    });
    expect(forbidden.statusCode).toBe(403);

    // Join by code works
    const join = await app.inject({
      method: "POST",
      url: "/api/play/join",
      payload: { gameCode: game.joinCode, nickname: "Ada" },
    });
    expect(join.statusCode).toBe(200);
    expect(JSON.parse(join.body).join.quizTitle).toBe("REST quiz");

    // Unknown code -> 404
    const bad = await app.inject({
      method: "POST",
      url: "/api/play/join",
      payload: { gameCode: "ZZZZZZ", nickname: "Ada" },
    });
    expect(bad.statusCode).toBe(404);
    expect(JSON.parse(bad.body).error?.code).toBe("INVALID_GAME_CODE");
  });

  it("nickname rules: taken in-room, freed by rejoin, stable player identity", async () => {
    const { token } = await registerUser(app);
    const { quizId } = await createPublishedQuiz(app, token, "Nick quiz", 1, 30);
    const game = await app.inject({ method: "POST", url: "/api/games", payload: { quizId }, ...withCookie(token) });
    const joinCode = JSON.parse(game.body).game.joinCode;

    const first = await joinPlayerAsCookie(app, joinCode, "Beyonce");
    const firstPlayerId = first.body.join.player.playerId;

    // Same nickname still active -> 409
    const dup = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: joinCode, nickname: "Beyonce" } });
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.body).error?.code).toBe("NICKNAME_TAKEN");

    // Rejoining with a new nickname returns the SAME playerId and frees the old name
    const rejoin = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: joinCode, nickname: "Queen B" }, cookies: first.pair });
    expect(rejoin.statusCode).toBe(200);
    expect(JSON.parse(rejoin.body).join.player.playerId).toBe(firstPlayerId);

    // Old nickname is free now
    const freed = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: joinCode, nickname: "Beyonce" } });
    expect(freed.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Socket: full day-in-the-life game flow
// ---------------------------------------------------------------------------

describe("socket game flow (server-authoritative)", () => {
  it("plays a 2-question game: answers, dup rejection, auto-end, results, finish, persistence", async () => {
    const { token } = await registerUser(app);
    const { quizId, questions } = await createPublishedQuiz(app, token, "Flow quiz", 2, 5);
    const created = await app.inject({ method: "POST", url: "/api/games", payload: { quizId }, ...withCookie(token) });
    const gameId = (JSON.parse(created.body).game as { id: string }).id;
    const joinCode = (JSON.parse(created.body).game as { joinCode: string }).joinCode;

    const p1 = await joinPlayerAsCookie(app, joinCode, "adele");
    const p2 = await joinPlayerAsCookie(app, joinCode, "dua");
    const q1 = questions[0]!;
    const q2 = questions[1]!;

    const host = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: `quiz_session=${token}` } });
    const s1 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p1.cookie } });
    const s2 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p2.cookie } });
    await Promise.all([waitFor(host, "connect"), waitFor(s1, "connect"), waitFor(s2, "connect")]);
    await sleep(400); // let the async room-attach finish

    const hostStateP = waitFor<{ phase: string; players: { nickname: string }[] }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    const hostState = await hostStateP;
    expect(hostState.phase).toBe("LOBBY");
    expect(hostState.players.map((p) => p.nickname).sort()).toEqual(["adele", "dua"]);

    // --- Q1 ---
    const q1ToPlayersP = waitFor<{ questionId: string }>(s1, "game:question");
    const startedP = waitFor<{ questionId: string; answerCount: number }>(host, "host:question-started");
    host.emit("host:start-question", { gameId, questionId: q1.id });
    const started = await startedP;
    expect(started.questionId).toBe(q1.id);
    expect(started.answerCount).toBe(0);
    const q1Payload = await q1ToPlayersP;
    expect(q1Payload.questionId).toBe(q1.id);
    expect("correct" in q1Payload).toBe(false); // no correctness leak

    const ack1P = waitFor<{ accepted: boolean; answerCount: number }>(s1, "player:answer-ack");
    const ack2P = waitFor<{ accepted: boolean; answerCount: number }>(s2, "player:answer-ack");
    s1.emit("player:submit-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    s2.emit("player:submit-answer", { gameId, questionId: q1.id, optionId: q1.wrongOptionId });
    const [ack1, ack2] = await Promise.all([ack1P, ack2P]);
    expect(ack1.accepted).toBe(true);
    expect(ack1.answerCount).toBe(1);
    expect(ack2.accepted).toBe(true);
    expect(ack2.answerCount).toBe(2);

    const dupP = waitFor<{ accepted: boolean; reason?: string }>(s1, "player:answer-ack");
    s1.emit("player:submit-answer", { gameId, questionId: q1.id, optionId: q1.wrongOptionId });
    const dup = await dupP;
    expect(dup.accepted).toBe(false);
    expect((dup.reason ?? "").toLowerCase()).toContain("already");

    const acP = waitFor<{ answerCount: number; questionId: string }>(host, "host:answer-count", 5000);
    const ac = await acP;
    expect(ac.answerCount).toBe(2);
    expect(ac.questionId).toBe(q1.id);

    // Auto-end fires ~5s after start
    const hostResP = waitFor<{ correctOptionId: string; optionCounts: { optionId: string; count: number }[] }>(host, "host:question-result", 12_000);
    const broadcastP = waitFor<{ correctOptionId: string }>(s1, "game:question-result", 12_000);
    const pr1P = waitFor<{ isCorrect: boolean; points: number; totalPoints: number }>(s1, "player:question-result", 12_000);
    const pr2P = waitFor<{ isCorrect: boolean; points: number }>(s2, "player:question-result", 12_000);
    const [hostRes, broadcast, pr1, pr2] = await Promise.all([hostResP, broadcastP, pr1P, pr2P]);
    expect(hostRes.optionCounts.find((o) => o.optionId === q1.correctOptionId)?.count).toBe(1);
    expect(broadcast.correctOptionId).toBe(q1.correctOptionId);
    expect(pr1.isCorrect).toBe(true);
    expect(pr1.points).toBeGreaterThan(0);
    expect(pr2.isCorrect).toBe(false);
    expect(pr2.points).toBe(0);

    // --- Q2 (manual end) ---
    const q2StartedP = waitFor<{ questionId: string; questionNumber: number }>(host, "host:question-started", 10_000);
    host.emit("host:next-question", { gameId });
    const q2Started = await q2StartedP;
    expect(q2Started.questionId).toBe(q2.id);
    expect(q2Started.questionNumber).toBe(2);

    const ackP = waitFor<{ accepted: boolean }>(s1, "player:answer-ack");
    s1.emit("player:submit-answer", { gameId, questionId: q2.id, optionId: q2.wrongOptionId });
    expect((await ackP).accepted).toBe(true);

    const q2ResP = waitFor<{ questionId: string }>(host, "host:question-result", 10_000);
    host.emit("host:end-question", { gameId });
    expect((await q2ResP).questionId).toBe(q2.id);

    // --- Finish ---
    const hostFinishP = waitFor<{ leaderboard: { playerId: string; nickname: string; score: number }[] }>(host, "host:game-finished", 10_000);
    const playerFinishP = waitFor<{ leaderboard: unknown[]; joinCode: string }>(s1, "game:finished", 10_000);
    host.emit("host:end-game", { gameId });
    const [hostFinish, playerFinish] = await Promise.all([hostFinishP, playerFinishP]);
    expect(hostFinish.leaderboard).toHaveLength(2);
    expect(playerFinish.leaderboard).toHaveLength(2);
    expect(playerFinish.joinCode).toBe(joinCode);

    // Player sync after finish
    const finalStateP = waitFor<{ phase: string; leaderboard: unknown[] }>(s1, "player:state", 10_000);
    s1.emit("player:sync", {});
    const finalState = await finalStateP;
    expect(finalState.phase).toBe("FINISHED");
    expect(finalState.leaderboard).toHaveLength(2);

    host.disconnect();
    s1.disconnect();
    s2.disconnect();

    // Finished game refuses new joiners
    const late = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: joinCode, nickname: "late" } });
    expect(late.statusCode).toBe(409);

    // PG persistence (background writes); poll briefly
    const { prisma } = await import("../src/db/client.js");
    let answers = 0;
    for (let i = 0; i < 20 && answers < 3; i++) {
      await sleep(250);
      answers = await prisma.answer.count({ where: { gameId } });
    }
    expect(answers).toBe(3);

    const session = await prisma.gameSession.findUnique({ where: { id: gameId } });
    expect(session?.status).toBe("FINISHED");
    const players = await prisma.player.findMany({ where: { gameId } });
    expect(players).toHaveLength(2);
    expect(players.reduce((s, p) => s + p.score, 0)).toBeGreaterThan(0);
    expect(players.find((p) => p.nickname === "adele")?.score).toBeGreaterThan(players.find((p) => p.nickname === "dua")?.score ?? 0);
  });
});