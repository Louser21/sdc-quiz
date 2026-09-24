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

/** Create a game from a published quiz and return ids + join code. */
async function createGame(token: string, quizId: string): Promise<{ gameId: string; joinCode: string }> {
  const created = await app.inject({ method: "POST", url: "/api/games", payload: { quizId }, ...withCookie(token) });
  expect(created.statusCode).toBe(201);
  const game = JSON.parse(created.body).game as { id: string; joinCode: string };
  return { gameId: game.id, joinCode: game.joinCode };
}

// ---------------------------------------------------------------------------
// Games + play REST
// ---------------------------------------------------------------------------

describe("games REST", () => {
  it("only creates a game from a published quiz, then lists/gets it", async () => {
    const { token } = await registerUser(app);
    const { quizId } = await createPublishedQuiz(app, token, "REST quiz", 1, 60);

    // Draft quiz rejected
    const draft = await app.inject({ method: "POST", url: "/api/games", payload: { quizId: "00000000-0000-4000-8000-000000000000" }, ...withCookie(token) });
    expect(draft.statusCode).toBe(404);

    const { gameId, joinCode } = await createGame(token, quizId);
    expect(joinCode).toMatch(/^[A-Z2-9]{6}$/);

    const list = await app.inject({ method: "GET", url: "/api/games", ...withCookie(token) });
    const games = JSON.parse(list.body).games;
    expect(games.map((g: { id: string }) => g.id)).toContain(gameId);

    const detail = await app.inject({ method: "GET", url: `/api/games/${gameId}`, ...withCookie(token) });
    expect(detail.statusCode).toBe(200);

    // Another host must not see it
    const other = await registerUser(app);
    const forbidden = await app.inject({ method: "GET", url: `/api/games/${gameId}`, ...withCookie(other.token) });
    expect(forbidden.statusCode).toBe(403);

    // Join by code works
    const join = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: joinCode, nickname: "Ada" } });
    expect(join.statusCode).toBe(200);
    expect(JSON.parse(join.body).join.quizTitle).toBe("REST quiz");

    // Unknown code -> 404
    const bad = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: "ZZZZZZ", nickname: "Ada" } });
    expect(bad.statusCode).toBe(404);
    expect(JSON.parse(bad.body).error?.code).toBe("INVALID_GAME_CODE");
  });

  it("nickname rules: taken in-room, freed by rejoin, stable player identity", async () => {
    const { token } = await registerUser(app);
    const { quizId } = await createPublishedQuiz(app, token, "Nick quiz", 1, 60);
    const { joinCode } = await createGame(token, quizId);

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

  it("rejects fresh joins once the paper has started (lobby only)", async () => {
    const { token } = await registerUser(app);
    const { quizId } = await createPublishedQuiz(app, token, "Started quiz", 1, 60);
    const { gameId, joinCode } = await createGame(token, quizId);
    await joinPlayerAsCookie(app, joinCode, "first-in");

    const host = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: `quiz_session=${token}` } });
    await waitFor(host, "connect");
    const stateP = waitFor<{ phase: string }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    await stateP;

    const startedP = waitFor<{ deadline: number }>(host, "host:paper-started");
    host.emit("host:start-paper", { gameId });
    const started = await startedP;
    expect(started.deadline).toBeGreaterThan(Date.now());

    // Fresh join rejected during ACTIVE
    const late = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: joinCode, nickname: "late" } });
    expect(late.statusCode).toBe(409);
    expect(JSON.parse(late.body).error?.code).toBe("GAME_NOT_JOINABLE");

    host.emit("host:end-paper", { gameId });
    await waitFor(host, "host:game-finished");
    host.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Socket: CBT paper flow
// ---------------------------------------------------------------------------

describe("socket paper flow (server-authoritative CBT)", () => {
  it("plays a 2-question paper: selections, mark, submit, auto-submit others, finish, persist", async () => {
    const { token } = await registerUser(app);
    const { quizId, questions } = await createPublishedQuiz(app, token, "Flow quiz", 2, 60);
    const { gameId, joinCode } = await createGame(token, quizId);
    const q1 = questions[0]!;
    const q2 = questions[1]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "adele");
    const p2 = await joinPlayerAsCookie(app, joinCode, "dua");

    const host = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: `quiz_session=${token}` } });
    const s1 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p1.cookie } });
    const s2 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p2.cookie } });
    await Promise.all([waitFor(host, "connect"), waitFor(s1, "connect"), waitFor(s2, "connect")]);
    await sleep(400); // let the async room-attach finish

    // --- Lobby ---
    const hostStateP = waitFor<{ phase: string; players: { nickname: string; submitted: boolean }[]; submittedCount: number }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    const hostState = await hostStateP;
    expect(hostState.phase).toBe("LOBBY");
    expect(hostState.players.map((p) => p.nickname).sort()).toEqual(["adele", "dua"]);
    expect(hostState.players.every((p) => !p.submitted)).toBe(true);
    expect(hostState.submittedCount).toBe(0);

    // Player sees the whole paper up front, with NO correctness info.
    const initialP = waitFor<{
      phase: string;
      questions: { questionId: string; text: string; options: { id: string }[] }[];
      selections: Record<string, string>;
      marked: Record<string, boolean>;
      scorecard: unknown;
      leaderboard: unknown;
    }>(s1, "player:state");
    s1.emit("player:sync", {});
    const initial = await initialP;
    expect(initial.phase).toBe("LOBBY");
    expect(initial.questions).toHaveLength(2);
    expect(initial.selections).toEqual({});
    expect(initial.marked).toEqual({});
    expect(initial.scorecard).toBeNull();
    expect(initial.leaderboard).toBeNull();
    for (const q of initial.questions) {
      expect(q).not.toHaveProperty("correct");
      expect(q).not.toHaveProperty("isCorrect");
      for (const o of q.options) expect(o).not.toHaveProperty("isCorrect");
    }

    // Selections are rejected before the paper starts.
    const tooEarlyP = waitFor<{ accepted: boolean; reason?: string }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    const tooEarly = await tooEarlyP;
    expect(tooEarly.accepted).toBe(false);
    expect(tooEarly.reason).toBeTruthy();

    // --- Start paper ---
    const paperStartedP = waitFor<{ deadline: number; timeLimitSeconds: number }>(host, "host:paper-started");
    const s1ActiveP = waitFor<{ phase: string; deadline: number | null; timeLimitSeconds: number }>(s1, "player:state");
    const s2ActiveP = waitFor<{ phase: string; deadline: number | null }>(s2, "player:state");
    host.emit("host:start-paper", { gameId });
    const [paperStarted, s1Active, s2Active] = await Promise.all([paperStartedP, s1ActiveP, s2ActiveP]);
    expect(paperStarted.timeLimitSeconds).toBe(60);
    expect(paperStarted.deadline).toBeGreaterThan(Date.now());
    expect(s1Active.phase).toBe("ACTIVE");
    expect(s1Active.deadline).toBe(paperStarted.deadline);
    expect(s2Active.phase).toBe("ACTIVE");

    // --- Selections (changeable until submit) ---
    const ackA = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    expect((await ackA).accepted).toBe(true);

    // Player can change their mind.
    const ackB = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.wrongOptionId });
    expect((await ackB).accepted).toBe(true);

    const syncB = waitFor<{ selections: Record<string, string> }>(s1, "player:state");
    s1.emit("player:sync", {});
    expect((await syncB).selections[q1.id]).toBe(q1.wrongOptionId);

    // Back to the correct answer, plus a second question selection.
    const ackC = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    expect((await ackC).accepted).toBe(true);
    const ackD = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q2.id, optionId: q2.wrongOptionId });
    expect((await ackD).accepted).toBe(true);

    // Player 2 answers wrong on Q1 only.
    const ackE = waitFor<{ accepted: boolean }>(s2, "player:set-answer-ack");
    s2.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.wrongOptionId });
    expect((await ackE).accepted).toBe(true);

    // Mark-for-review shows up on the next authoritative state push.
    s2.emit("player:mark-review", { gameId, questionId: q1.id, marked: true });
    await sleep(200);
    const s2SyncP = waitFor<{ marked: Record<string, boolean> }>(s2, "player:state");
    s2.emit("player:sync", {});
    const s2Sync = await s2SyncP;
    expect(s2Sync.marked[q1.id]).toBe(true);

    // --- Player 1 submits early (scorecard + host notification) ---
    const scorecardP = waitFor<{ correctCount: number; totalQuestions: number; score: number; submitted: boolean }>(s1, "player:scorecard");
    const hostSubP = waitFor<{ playerId: string; nickname: string; submittedCount: number }>(host, "host:player-submitted");
    s1.emit("player:submit-paper", { gameId });
    const [scorecard, hostSub] = await Promise.all([scorecardP, hostSubP]);
    expect(scorecard.submitted).toBe(true);
    expect(scorecard.correctCount).toBe(1);
    expect(scorecard.totalQuestions).toBe(2);
    expect(scorecard.score).toBeGreaterThan(0);
    expect(hostSub.nickname).toBe("adele");
    expect(hostSub.submittedCount).toBe(1);

    // Paper is now locked for player 1: further edits are rejected atomically.
    const lateEditP = waitFor<{ accepted: boolean; reason?: string }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q2.id, optionId: q2.correctOptionId });
    const lateEdit = await lateEditP;
    expect(lateEdit.accepted).toBe(false);
    expect((lateEdit.reason ?? "").toLowerCase()).toContain("already");

    // Only one of two submitted -> paper still ACTIVE.
    const stillActiveP = waitFor<{ phase: string; submittedCount: number }>(host, "host:state");
    host.emit("host:sync");
    const stillActive = await stillActiveP;
    expect(stillActive.phase).toBe("ACTIVE");
    expect(stillActive.submittedCount).toBe(1);

    // --- Host ends early: everyone else is auto-submitted ---
    const hostFinishP = waitFor<{ leaderboard: { playerId: string; nickname: string; score: number }[] }>(host, "host:game-finished");
    const s1FinishP = waitFor<{ leaderboard: unknown[]; joinCode: string }>(s1, "game:finished");
    const s2FinishP = waitFor<{ leaderboard: unknown[]; joinCode: string }>(s2, "game:finished");
    host.emit("host:end-paper", { gameId });
    const [hostFinish, s1Finish, s2Finish] = await Promise.all([hostFinishP, s1FinishP, s2FinishP]);
    expect(hostFinish.leaderboard).toHaveLength(2);
    expect(s1Finish.leaderboard).toHaveLength(2);
    expect(s2Finish.joinCode).toBe(joinCode);
    // Fixed scoring: 1 correct -> SCORE_BASE (1000 by default) beats the auto-submitted 0.
    expect(hostFinish.leaderboard[0]?.nickname).toBe("adele");
    expect(hostFinish.leaderboard[0]?.score).toBeGreaterThan(hostFinish.leaderboard[1]?.score ?? -1);

    // Player state after finish: scorecard present, leaderboard visible.
    const finalP = waitFor<{ phase: string; leaderboard: unknown[]; scorecard: { correctCount: number } | null }>(s1, "player:state");
    s1.emit("player:sync", {});
    const final = await finalP;
    expect(final.phase).toBe("FINISHED");
    expect(final.leaderboard).toHaveLength(2);
    expect(final.scorecard?.correctCount).toBe(1);

    host.disconnect();
    s1.disconnect();
    s2.disconnect();

    // Finished game refuses new joiners
    const late = await app.inject({ method: "POST", url: "/api/play/join", payload: { gameCode: joinCode, nickname: "late" } });
    expect(late.statusCode).toBe(409);
    expect(JSON.parse(late.body).error?.code).toBe("GAME_FINISHED");

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
    expect(session?.endedAt).not.toBeNull();
    const players = await prisma.player.findMany({ where: { gameId } });
    expect(players).toHaveLength(2);
    expect(players.find((p) => p.nickname === "adele")?.score).toBe(1000);
    expect(players.find((p) => p.nickname === "dua")?.score).toBe(0);
  });

  it("finishes naturally when every player has submitted", async () => {
    const { token } = await registerUser(app);
    const { quizId, questions } = await createPublishedQuiz(app, token, "Natural end", 1, 60);
    const { gameId, joinCode } = await createGame(token, quizId);
    const q1 = questions[0]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "amy");
    const p2 = await joinPlayerAsCookie(app, joinCode, "joe");

    const host = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: `quiz_session=${token}` } });
    const s1 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p1.cookie } });
    const s2 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p2.cookie } });
    await Promise.all([waitFor(host, "connect"), waitFor(s1, "connect"), waitFor(s2, "connect")]);
    await sleep(400);

    const hostStateP = waitFor<{ phase: string }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    await hostStateP;

    const startedP = waitFor<{ deadline: number }>(host, "host:paper-started");
    host.emit("host:start-paper", { gameId });
    await startedP;

    await Promise.all([
      (async () => {
        const a = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
        s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
        return a;
      })(),
      (async () => {
        const a = waitFor<{ accepted: boolean }>(s2, "player:set-answer-ack");
        s2.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.wrongOptionId });
        return a;
      })(),
    ]);

    // First submit: still active.
    const firstScoreP = waitFor<{ score: number }>(s1, "player:scorecard");
    s1.emit("player:submit-paper", { gameId });
    await firstScoreP;

    // Second (last) submit triggers the natural finish for everyone.
    const hostFinishP = waitFor<{ leaderboard: { nickname: string; score: number }[] }>(host, "host:game-finished");
    const s2FinishP = waitFor<{ joinCode: string }>(s2, "game:finished");
    const s1FinishP = waitFor<{ joinCode: string }>(s1, "game:finished");
    s2.emit("player:submit-paper", { gameId });
    const [hostFinish] = await Promise.all([hostFinishP, s2FinishP, s1FinishP]);
    expect(hostFinish.leaderboard).toHaveLength(2);
    expect(hostFinish.leaderboard[0]?.nickname).toBe("amy");
    expect(hostFinish.leaderboard[0]?.score).toBe(1000);
    expect(hostFinish.leaderboard[1]?.score).toBe(0);

    host.disconnect();
    s1.disconnect();
    s2.disconnect();
  });

  it("auto-submits every outstanding paper when the deadline passes", async () => {
    const { token } = await registerUser(app);
    const { quizId, questions } = await createPublishedQuiz(app, token, "Deadline quiz", 2, 60);
    const { gameId, joinCode } = await createGame(token, quizId);
    const q1 = questions[0]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "early");
    const p2 = await joinPlayerAsCookie(app, joinCode, "slow");

    // Shrink the paper's time limit directly in Redis so the real wall-clock
    // deadline path runs in ~2s instead of 60s (same code path, faster clock).
    const { redis } = await import("../src/redis/client.js");
    await redis.hset(`game:${gameId}`, "timeLimitSeconds", "2");

    const host = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: `quiz_session=${token}` } });
    const s1 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p1.cookie } });
    const s2 = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: p2.cookie } });
    await Promise.all([waitFor(host, "connect"), waitFor(s1, "connect"), waitFor(s2, "connect")]);
    await sleep(400);

    const hostStateP = waitFor<{ phase: string }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    await hostStateP;

    const startedP = waitFor<{ deadline: number; timeLimitSeconds: number }>(host, "host:paper-started");
    host.emit("host:start-paper", { gameId });
    const started = await startedP;
    expect(started.timeLimitSeconds).toBe(2);
    expect(started.deadline).toBeLessThanOrEqual(Date.now() + 2500);

    // Player 1 answers; player 2 answers nothing. Nobody submits manually.
    const ackP = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    expect((await ackP).accepted).toBe(true);

    // The deadline fires and auto-finishes the paper for both players.
    const hostFinishP = waitFor<{ leaderboard: { nickname: string; score: number }[] }>(host, "host:game-finished", 15_000);
    const s1FinishP = waitFor<{ joinCode: string }>(s1, "game:finished", 15_000);
    const s2FinishP = waitFor<{ joinCode: string }>(s2, "game:finished", 15_000);
    const [hostFinish] = await Promise.all([hostFinishP, s1FinishP, s2FinishP]);

    // Both were auto-submitted; score reflects the selections each had.
    expect(hostFinish.leaderboard).toHaveLength(2);
    expect(hostFinish.leaderboard[0]?.nickname).toBe("early");
    expect(hostFinish.leaderboard[0]?.score).toBe(1000);
    expect(hostFinish.leaderboard[1]?.score).toBe(0);

    const finalP = waitFor<{ phase: string; leaderboard: unknown[] }>(s2, "player:state");
    s2.emit("player:sync", {});
    const final = await finalP;
    expect(final.phase).toBe("FINISHED");
    expect(final.leaderboard).toHaveLength(2);

    host.disconnect();
    s1.disconnect();
    s2.disconnect();

    // Selections were persisted from the auto-submit finalize path.
    const { prisma } = await import("../src/db/client.js");
    let answers = 0;
    for (let i = 0; i < 20 && answers < 1; i++) {
      await sleep(250);
      answers = await prisma.answer.count({ where: { gameId } });
    }
    expect(answers).toBeGreaterThanOrEqual(1);
    const session = await prisma.gameSession.findUnique({ where: { id: gameId } });
    expect(session?.status).toBe("FINISHED");
  });
});