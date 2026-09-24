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

/** Spin up a full temporary live server (for restart-recovery tests). */
function bootServer() {
  return startLiveServer();
}

function connect(base: string, cookie?: string): Socket {
  return ioc(base, {
    transports: ["websocket"],
    ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}),
  });
}

async function setupPaper(
  token: string,
  questionCount = 2,
  timeLimitSeconds = 60,
): Promise<{
  gameId: string;
  joinCode: string;
  questions: { id: string; correctOptionId: string; wrongOptionId: string }[];
}> {
  const { quizId, questions } = await createPublishedQuiz(app, token, "Recovery quiz", questionCount, timeLimitSeconds);
  const created = await app.inject({ method: "POST", url: "/api/games", payload: { quizId }, ...withCookie(token) });
  expect(created.statusCode).toBe(201);
  const game = JSON.parse(created.body).game as { id: string; joinCode: string };
  return { gameId: game.id, joinCode: game.joinCode, questions };
}

// ---------------------------------------------------------------------------
// Player reconnect / refresh / network-switch recovery
// ---------------------------------------------------------------------------

describe("player reconnect recovery", () => {
  it("restores selections, marks and submission across reconnect; rejects edits once submitted", async () => {
    const { token } = await registerUser(app);
    const { gameId, joinCode, questions } = await setupPaper(token, 2);
    const q1 = questions[0]!;
    const q2 = questions[1]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "mobile");
    const p2 = await joinPlayerAsCookie(app, joinCode, "stable");

    const host = connect(ctx.base, `quiz_session=${token}`);
    const s1 = connect(ctx.base, p1.cookie);
    const s2 = connect(ctx.base, p2.cookie);
    await Promise.all([waitFor(host, "connect"), waitFor(s1, "connect"), waitFor(s2, "connect")]);
    await sleep(400);

    const hostStateP = waitFor<{ phase: string }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    await hostStateP;
    const startedP = waitFor<{ deadline: number }>(host, "host:paper-started");
    host.emit("host:start-paper", { gameId });
    await startedP;

    // Player 1 works, then their network drops.
    const ack1 = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    expect((await ack1).accepted).toBe(true);
    s1.emit("player:mark-review", { gameId, questionId: q1.id, marked: true });
    const ack2 = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q2.id, optionId: q2.wrongOptionId });
    expect((await ack2).accepted).toBe(true);
    s1.disconnect();
    await sleep(300); // let the server record the disconnect

    // Reconnect with the same cookie (refresh / network switch) -> full state back.
    const s1b = connect(ctx.base, p1.cookie);
    await waitFor(s1b, "connect");
    const restoredP = waitFor<{
      phase: string;
      selections: Record<string, string>;
      marked: Record<string, boolean>;
      scorecard: unknown;
      player: { submitted: boolean };
    }>(s1b, "player:state");
    s1b.emit("player:sync", {});
    const restored = await restoredP;
    expect(restored.phase).toBe("ACTIVE");
    expect(restored.selections[q1.id]).toBe(q1.correctOptionId);
    expect(restored.selections[q2.id]).toBe(q2.wrongOptionId);
    expect(restored.marked[q1.id]).toBe(true);
    expect(restored.scorecard).toBeNull();
    expect(restored.player.submitted).toBe(false);

    // Submit from the recovered socket.
    const scoreP = waitFor<{ correctCount: number; score: number }>(s1b, "player:scorecard");
    s1b.emit("player:submit-paper", { gameId });
    const score = await scoreP;
    expect(score.correctCount).toBe(1);
    expect(score.score).toBe(1000);

    // Drop again, reconnect, and verify the submission is authoritative + immutable.
    s1b.disconnect();
    await sleep(300);
    const s1c = connect(ctx.base, p1.cookie);
    await waitFor(s1c, "connect");
    const submittedP = waitFor<{
      player: { submitted: boolean };
      scorecard: { correctCount: number; score: number };
      selections: Record<string, string>;
      leaderboard: unknown;
    }>(s1c, "player:state");
    s1c.emit("player:sync", {});
    const submitted = await submittedP;
    expect(submitted.player.submitted).toBe(true);
    expect(submitted.scorecard?.correctCount).toBe(1);
    expect(submitted.selections[q2.id]).toBe(q2.wrongOptionId);
    expect(submitted.leaderboard).toBeNull(); // not revealed while the paper runs

    // Post-submit edits are rejected even from a freshly recovered socket.
    const lateAckP = waitFor<{ accepted: boolean; reason?: string }>(s1c, "player:set-answer-ack");
    s1c.emit("player:set-answer", { gameId, questionId: q2.id, optionId: q2.correctOptionId });
    const lateAck = await lateAckP;
    expect(lateAck.accepted).toBe(false);

    // Re-submitting is a harmless idempotent no-op that returns the same scorecard.
    const againP = waitFor<{ score: number }>(s1c, "player:scorecard");
    s1c.emit("player:submit-paper", { gameId });
    expect((await againP).score).toBe(1000);

    host.emit("host:end-paper", { gameId });
    await waitFor(host, "host:game-finished");
    s1c.disconnect();
    host.disconnect();

    // Exactly ONE paper persisted per player (no duplicates from reconnect storms).
    const { prisma } = await import("../src/db/client.js");
    let rows = 0;
    for (let i = 0; i < 20 && rows < 2; i++) {
      await sleep(250);
      rows = await prisma.answer.count({ where: { gameId } });
    }
    expect(rows).toBe(2);
    const players = await prisma.player.findMany({ where: { gameId } });
    expect(players.find((p) => p.nickname === "mobile")?.score).toBe(1000);
    expect(players.find((p) => p.nickname === "stable")?.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Host reconnect / host-disconnect policy
// ---------------------------------------------------------------------------

describe("host disconnect + reconnect recovery", () => {
  it("keeps the paper running without the host, then restores controls on rejoin", async () => {
    const { token } = await registerUser(app);
    const { gameId, joinCode, questions } = await setupPaper(token, 1);
    const q1 = questions[0]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "alone");

    const host = connect(ctx.base, `quiz_session=${token}`);
    const s1 = connect(ctx.base, p1.cookie);
    await Promise.all([waitFor(host, "connect"), waitFor(s1, "connect")]);
    await sleep(400);

    const hostStateP = waitFor<{ phase: string }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    await hostStateP;
    const startedP = waitFor<{ deadline: number }>(host, "host:paper-started");
    host.emit("host:start-paper", { gameId });
    await startedP;

    // Host network drops. The paper must keep running for participants.
    host.disconnect();
    await sleep(400);

    const hostGoneP = waitFor<{ hostPresent: boolean }>(s1, "player:state");
    s1.emit("player:sync", {});
    const hostGone = await hostGoneP;
    expect(hostGone.hostPresent).toBe(false);

    // Participant can still answer while the host is away.
    const ackP = waitFor<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    expect((await ackP).accepted).toBe(true);

    // Host comes back: rejoin restores the console with full live state.
    const host2 = connect(ctx.base, `quiz_session=${token}`);
    await waitFor(host2, "connect");
    const restoredP = waitFor<{
      phase: string;
      players: { nickname: string; submitted: boolean }[];
      submittedCount: number;
    }>(host2, "host:state");
    host2.emit("host:join-game", { gameId });
    const restored = await restoredP;
    expect(restored.phase).toBe("ACTIVE");
    expect(restored.players.map((p) => p.nickname)).toContain("alone");
    expect(restored.submittedCount).toBe(0);

    // Restored host can end the paper normally.
    const finishP = waitFor<{ leaderboard: unknown[] }>(host2, "host:game-finished");
    host2.emit("host:end-paper", { gameId });
    const finish = await finishP;
    expect(finish.leaderboard).toHaveLength(1);

    // During FINISHED the reconnecting host sees the final console.
    const host3 = connect(ctx.base, `quiz_session=${token}`);
    await waitFor(host3, "connect");
    const finalP = waitFor<{ phase: string; leaderboard: unknown[] }>(host3, "host:state");
    host3.emit("host:join-game", { gameId });
    const final = await finalP;
    expect(final.phase).toBe("FINISHED");
    expect(final.leaderboard).toHaveLength(1);

    s1.disconnect();
    host2.disconnect();
    host3.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Backend restart recovery
// ---------------------------------------------------------------------------

describe("backend restart recovery", () => {
  it("re-arms the deadline timer from Redis after a full API restart and finishes the paper", async () => {
    const { token } = await registerUser(app);
    const { quizId, questions } = await createPublishedQuiz(app, token, "Restart quiz", 1, 60);
    const q1 = questions[0]!;
    const created = await app.inject({ method: "POST", url: "/api/games", payload: { quizId }, ...withCookie(token) });
    expect(created.statusCode).toBe(201);
    const game = JSON.parse(created.body).game as { id: string; joinCode: string };
    const gameId = game.id;
    const joinCode = game.joinCode;

    const p1 = await joinPlayerAsCookie(app, joinCode, "survivor");
    const p2 = await joinPlayerAsCookie(app, joinCode, "awol");

    // First API process.
    const a1 = await bootServer();
    const host = connect(a1.base, `quiz_session=${token}`);
    await waitFor(host, "connect");
    const hostStateP = waitFor<{ phase: string }>(host, "host:state");
    host.emit("host:join-game", { gameId });
    await hostStateP;

    // Shorten the paper directly in Redis so the wall-clock deadline is ~3s.
    const { redis } = await import("../src/redis/client.js");
    await redis.hset(`game:${gameId}`, "timeLimitSeconds", "3");

    const startedP = waitFor<{ deadline: number }>(host, "host:paper-started");
    host.emit("host:start-paper", { gameId });
    const started = await startedP;
    const deadline = started.deadline;
    expect(deadline).toBeGreaterThan(Date.now());

    // One player answers on process A; then the whole API dies.
    const sA = connect(a1.base, p1.cookie);
    await waitFor(sA, "connect");
    // (second player never connects at all — they dropped out too)
    await sleep(150);
    const ackP = waitFor<{ accepted: boolean }>(sA, "player:set-answer-ack");
    sA.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    expect((await ackP).accepted).toBe(true);
    sA.disconnect();
    host.disconnect();
    await a1.io.close();
    await a1.app.close();

    // Boot a fresh API process against the SAME Redis: it must re-arm the
    // deadline timer and finish the paper for every connected player.
    const a2 = await bootServer();
    try {
      const s1 = connect(a2.base, p1.cookie);
      const s2 = connect(a2.base, p2.cookie);
      await Promise.all([waitFor(s1, "connect", 10_000), waitFor(s2, "connect", 10_000)]);

      // Give the restored (orphaned) deadline timer time to fire. The sync
      // below asserts the finished state itself, so there is no event race.
      await sleep(Math.max(300, deadline + 500 - Date.now()));

      const s1P = waitFor<{
        phase: string;
        leaderboard: unknown[];
        scorecard: { score: number } | null;
      }>(s1, "player:state");
      s1.emit("player:sync", {});
      const s1Final = await s1P;
      expect(s1Final.phase).toBe("FINISHED");
      expect(s1Final.leaderboard).toHaveLength(2);
      expect(s1Final.scorecard?.score).toBe(1000);

      // Both players were auto-submitted by the restored timer.
      const s2P = waitFor<{ phase: string; player: { submitted: boolean } }>(s2, "player:state");
      s2.emit("player:sync", {});
      const s2Final = await s2P;
      expect(s2Final.phase).toBe("FINISHED");
      expect(s2Final.player.submitted).toBe(true);

      s1.disconnect();
      s2.disconnect();
    } finally {
      await a2.io.close();
      await a2.app.close();
    }

    // The restarted process persisted the finish.
    const { prisma } = await import("../src/db/client.js");
    let rows = 0;
    for (let i = 0; i < 20 && rows < 1; i++) {
      await sleep(250);
      rows = await prisma.answer.count({ where: { gameId } });
    }
    expect(rows).toBeGreaterThanOrEqual(1);
    const session = await prisma.gameSession.findUnique({ where: { id: gameId } });
    expect(session?.status).toBe("FINISHED");
    expect(session?.endedAt).not.toBeNull();
  });
});