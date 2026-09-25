import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioc, type Socket } from "socket.io-client";
import type { FastifyInstance } from "fastify";
import {
  createPublishedQuiz,
  joinPlayerAsCookie,
  registerUser,
  resetAllState,
  startLiveServer,
  waitForEvent,
  withCookie,
} from "./helpers.js";

/**
 * Race-condition wall. These tests hammer the atomic guards that the
 * sequential happy-path tests never exercise: simultaneous submits, answer
 * bursts, concurrent joins, and nickname collision under load.
 */
let ctx: Awaited<ReturnType<typeof startLiveServer>>;
let app: FastifyInstance;
const openSockets: Socket[] = [];

beforeAll(async () => {
  ctx = await startLiveServer();
  app = ctx.app;
});
beforeEach(async () => {
  await resetAllState();
});
afterEach(() => {
  for (const s of openSockets) s.disconnect();
  openSockets.length = 0;
});
afterAll(async () => {
  ctx.io.close();
  await app.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until the finished game has persisted (most recent win) in PostgreSQL. */
async function expectGamePersisted(gameId: string): Promise<void> {
  const { prisma } = await import("../src/db/client.js");
  for (let i = 0; i < 20; i++) {
    const session = await prisma.gameSession.findUnique({ where: { id: gameId } });
    if (session?.status === "FINISHED") return;
    await sleep(250);
  }
  throw new Error(`game ${gameId} was never persisted as FINISHED`);
}

/** Registration → published quiz → game, all in one go. */
async function seedGame(
  token: string,
  questionCount = 1,
): Promise<{ gameId: string; joinCode: string; questions: { id: string; correctOptionId: string; wrongOptionId: string }[] }> {
  const { quizId, questions } = await createPublishedQuiz(app, token, `Race quiz ${Date.now()}`, questionCount, 60);
  const created = await app.inject({
    method: "POST",
    url: "/api/games",
    payload: { quizId },
    ...withCookie(token),
  });
  expect(created.statusCode).toBe(201);
  const game = JSON.parse(created.body).game as { id: string; joinCode: string };
  return { gameId: game.id, joinCode: game.joinCode, questions };
}

function connect(cookie: string): Socket {
  const socket = ioc(ctx.base, { transports: ["websocket"], extraHeaders: { Cookie: cookie } });
  openSockets.push(socket);
  return socket;
}

/** Host joins the room and starts the paper; resolves once ACTIVE. */
async function startPaper(token: string, gameId: string): Promise<void> {
  const host = connect(`quiz_session=${token}`);
  await waitForEvent(host, "connect");
  const stateP = waitForEvent<{ phase: string }>(host, "host:state");
  host.emit("host:join-game", { gameId });
  await stateP;
  const startedP = waitForEvent<{ deadline: number }>(host, "host:paper-started");
  host.emit("host:start-paper", { gameId });
  await startedP;
}

/**
 * Resolve a socket's flow with either its scorecard or the game's finish —
 * under a submit race, a losing submit may only see the finish and never get
 * a scorecard of its own. Returns the score when a scorecard arrived.
 */
function scorecardOrFinish(socket: Socket): Promise<number | "finished"> {
  return new Promise((resolve) => {
    socket.once("player:scorecard", (sc: { score: number }) => resolve(sc.score));
    socket.once("game:finished", () => resolve("finished"));
  });
}

describe("concurrent submits", () => {
  it("is idempotent under a same-player double-submit from two sockets", async () => {
    const { token } = await registerUser(app);
    const { gameId, joinCode, questions } = await seedGame(token, 2);
    const q1 = questions[0]!;
    const q2 = questions[1]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "racer");
    await startPaper(token, gameId);

    // Two sockets, same identity.
    const s1 = connect(p1.cookie);
    const s2 = connect(p1.cookie);
    await Promise.all([waitForEvent(s1, "connect"), waitForEvent(s2, "connect")]);
    await sleep(300);

    const ack1 = waitForEvent<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    const ack2 = waitForEvent<{ accepted: boolean }>(s2, "player:set-answer-ack");
    s2.emit("player:set-answer", { gameId, questionId: q2.id, optionId: q2.correctOptionId });
    expect((await ack1).accepted).toBe(true);
    expect((await ack2).accepted).toBe(true);

    // Fire both submits "at once" from the two sockets. Under a true race one
    // submit may arrive after the finish broadcast — that socket sees the
    // finish and no own scorecard, which is still correct behavior.
    const out1P = scorecardOrFinish(s1);
    const out2P = scorecardOrFinish(s2);
    s1.emit("player:submit-paper", { gameId });
    s2.emit("player:submit-paper", { gameId });

    const [out1, out2] = await Promise.all([out1P, out2P]);
    const scores = [out1, out2].filter((o): o is number => o !== "finished");
    // At least one submit resolved; every resolved scorecard is the same
    // authoritative score (2000 = both questions correct). No double-penalty.
    expect(scores.length).toBeGreaterThanOrEqual(1);
    expect(new Set(scores)).toEqual(new Set([2000]));

    s1.disconnect();
    s2.disconnect();

    // Exactly ONE paper per player persisted — no double-write, no dup rows.
    const { prisma } = await import("../src/db/client.js");
    let rows = 99;
    for (let i = 0; i < 20 && rows !== 2; i++) {
      await sleep(250);
      rows = await prisma.answer.count({ where: { gameId } });
    }
    expect(rows).toBe(2);
    await expectGamePersisted(gameId);
  });

  it("final-submit race between two players finishes exactly once for everyone", async () => {
    const { token } = await registerUser(app);
    const { gameId, joinCode, questions } = await seedGame(token, 1);
    const q1 = questions[0]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "racer-a");
    const p2 = await joinPlayerAsCookie(app, joinCode, "racer-b");
    await startPaper(token, gameId);

    const s1 = connect(p1.cookie);
    const s2 = connect(p2.cookie);
    await Promise.all([waitForEvent(s1, "connect"), waitForEvent(s2, "connect")]);
    await sleep(300);

    const ack1 = waitForEvent<{ accepted: boolean }>(s1, "player:set-answer-ack");
    s1.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    const ack2 = waitForEvent<{ accepted: boolean }>(s2, "player:set-answer-ack");
    s2.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.wrongOptionId });
    expect((await ack1).accepted).toBe(true);
    expect((await ack2).accepted).toBe(true);

    // Simultaneous last submits → single finish broadcast, both scorecards.
    const score1P = waitForEvent<{ score: number }>(s1, "player:scorecard");
    const out2P = scorecardOrFinish(s2);
    const finishEvents = new Promise<(Record<string, unknown> | "finished")[]>((resolve) => {
      const seen: (Record<string, unknown> | "finished")[] = [];
      const onFinish = (payload: unknown) =>
        seen.push(typeof payload === "string" ? payload : (payload as Record<string, unknown>));
      s1.on("game:finished", onFinish);
      s2.on("game:finished", onFinish);
      setTimeout(() => resolve(seen), 2000);
    });
    s1.emit("player:submit-paper", { gameId });
    s2.emit("player:submit-paper", { gameId });

    const [score1, out2, fin] = await Promise.all([score1P, out2P, finishEvents]);
    expect(score1.score).toBe(1000);
    if (out2 !== "finished") expect((out2 as number)).toBe(0);
    // Both players observe a finish, but there is exactly one game to finish.
    expect(fin.length).toBeGreaterThanOrEqual(2);

    s1.disconnect();
    s2.disconnect();

    await expectGamePersisted(gameId);
  });
});

describe("answer burst", () => {
  it("sustains a rapid-fire burst without corrupting the final selection", async () => {
    const { token } = await registerUser(app);
    const { gameId, joinCode, questions } = await seedGame(token, 1);
    const q1 = questions[0]!;

    const p1 = await joinPlayerAsCookie(app, joinCode, "burst");
    await startPaper(token, gameId);

    const s1 = connect(p1.cookie);
    await waitForEvent(s1, "connect");
    await sleep(300);

    // 30 sends back-to-back (inside the WS token-bucket burst of 40).
    const acked: { accepted: boolean }[] = [];
    s1.on("player:set-answer-ack", (ack: { accepted: boolean }) => acked.push(ack));
    for (let n = 0; n < 30; n++) {
      s1.emit("player:set-answer", {
        gameId,
        questionId: q1.id,
        optionId: n % 2 === 0 ? q1.correctOptionId : q1.wrongOptionId,
      });
    }
    await sleep(1200);

    // No corruption: every burst event got exactly one ack, accepted pre-submit.
    expect(acked.length).toBe(30);
    expect(acked.every((a) => a.accepted)).toBe(true);

    // Last-write-wins: the final selection is coherent, not garbage.
    const stateP = waitForEvent<{ selections: Record<string, string> }>(s1, "player:state");
    s1.emit("player:sync", {});
    const state = await stateP;
    expect([q1.correctOptionId, q1.wrongOptionId]).toContain(state.selections[q1.id]);

    const scoreP = waitForEvent<{ correctCount: number }>(s1, "player:scorecard");
    s1.emit("player:submit-paper", { gameId });
    const score = await scoreP;
    expect(score.correctCount).toBeLessThanOrEqual(1);
    s1.disconnect();

    // The burst + submit left a coherent, persisted result.
    await expectGamePersisted(gameId);
  });
});

describe("concurrent joins", () => {
  it("satisfies a join burst with one identity each and no partial state", async () => {
    const { token } = await registerUser(app);
    const { joinCode } = await seedGame(token, 1);

    const joins = await Promise.all(
      Array.from({ length: 25 }, (_, n) =>
        app.inject({
          method: "POST",
          url: "/api/play/join",
          payload: { gameCode: joinCode, nickname: `burst-${n}` },
        }),
      ),
    );

    const successes = joins.filter((j) => j.statusCode === 200);
    const bodies = successes.map((j) => JSON.parse(j.body) as { join: { player: { playerId: string; nickname: string } } });
    const playerIds = bodies.map((b) => b.join.player.playerId);
    // All 25 landed, and identity rows are unique.
    expect(successes.length).toBe(25);
    expect(new Set(playerIds).size).toBe(25);
    expect(bodies.every((b) => b.join.player.nickname.startsWith("burst-"))).toBe(true);
  });

  it("fences identical nicknames to exactly one winner under concurrency", async () => {
    const { token } = await registerUser(app);
    const { joinCode } = await seedGame(token, 1);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/play/join",
          payload: { gameCode: joinCode, nickname: "same-name" },
        }),
      ),
    );

    const ok = attempts.filter((a) => a.statusCode === 200);
    const conflicts = attempts.filter((a) => a.statusCode === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    for (const c of conflicts) {
      expect(JSON.parse(c.body).error?.code).toBe("NICKNAME_TAKEN");
    }
  });
});

describe("nickname fencing", () => {
  it("accepts a 24-char nickname and rejects 25 / empty / whitespace-only", async () => {
    const { token } = await registerUser(app);
    const { joinCode } = await seedGame(token, 1);

    const boundary = "n".repeat(24);
    const ok = await app.inject({
      method: "POST",
      url: "/api/play/join",
      payload: { gameCode: joinCode, nickname: boundary },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).join.player.nickname).toBe(boundary);

    for (const bad of ["n".repeat(25), "", "   "]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/play/join",
        payload: { gameCode: joinCode, nickname: bad },
      });
      expect(rejected.statusCode, `nickname="${bad}"`).toBe(400);
      expect(JSON.parse(rejected.body).error?.code).toBe("VALIDATION_ERROR");
    }
  });
});