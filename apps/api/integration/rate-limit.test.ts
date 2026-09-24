import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioc, type Socket } from "socket.io-client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  createPublishedQuiz,
  joinPlayerAsCookie,
  registerUser,
  resetDb,
  startLiveServer,
  withCookie,
} from "./helpers.js";

// App with tight rate limits to exercise 429s without waiting a real minute.
let rlApp: FastifyInstance;
// Default-config live server (real TCP + Socket.IO) for the WS token-bucket test.
let live: Awaited<ReturnType<typeof startLiveServer>>;
let app: FastifyInstance;

beforeAll(async () => {
  rlApp = await buildApp({ rateLimit: { loginMax: 2, registerMax: 4, joinMax: 3, globalMax: 500 } });
  await rlApp.ready();
  live = await startLiveServer();
  app = live.app;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  live.io.close();
  await live.app.close();
  await rlApp.close();
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

async function createGame(instance: FastifyInstance, token: string, quizId: string): Promise<{ gameId: string; joinCode: string }> {
  const created = await instance.inject({ method: "POST", url: "/api/games", payload: { quizId }, ...withCookie(token) });
  expect(created.statusCode).toBe(201);
  const game = JSON.parse(created.body).game as { id: string; joinCode: string };
  return { gameId: game.id, joinCode: game.joinCode };
}

describe("HTTP rate limiting", () => {
  it("limits POST /api/play/join per IP and returns the RATE_LIMITED envelope", async () => {
    const { token } = await registerUser(rlApp);
    const { quizId } = await createPublishedQuiz(rlApp, token, "RL quiz", 1, 60);
    const { joinCode } = await createGame(rlApp, token, quizId);

    for (let n = 0; n < 3; n++) {
      const ok = await rlApp.inject({
        method: "POST",
        url: "/api/play/join",
        payload: { gameCode: joinCode, nickname: `player-${n}` },
      });
      expect(ok.statusCode).toBe(200);
    }

    const blocked = await rlApp.inject({
      method: "POST",
      url: "/api/play/join",
      payload: { gameCode: joinCode, nickname: "flood" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(blocked.body)).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
  });

  it("limits POST /api/auth/login (brute-force surface) after the allowance", async () => {
    for (let n = 0; n < 2; n++) {
      const attempt = await rlApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@example.com", password: "wrong" },
      });
      expect(attempt.statusCode).toBe(401);
    }
    const blocked = await rlApp.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: "wrong" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(blocked.body).error?.code).toBe("RATE_LIMITED");
  });
});

describe("metrics endpoint", () => {
  it("exposes Prometheus text with HTTP + WS counters on GET /api/metrics", async () => {
    await registerUser(rlApp); // produces some http_requests_total entries
    await rlApp.inject({ method: "GET", url: "/api/metrics" }); // warm-up: this request counts itself on the next pull
    const resp = await rlApp.inject({ method: "GET", url: "/api/metrics" });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers["content-type"]).toContain("text/plain");
    expect(resp.body).toContain("quiz_http_requests_total{");
    expect(resp.body).toContain("quiz_http_requests_total{method=\"GET\",route=\"/api/metrics\",status=\"200\"}");
    expect(resp.body).toMatch(/quiz_live_games \d+/);
    expect(resp.body).toMatch(/quiz_live_players \d+/);
  });
});

describe("socket token bucket", () => {
  it("rejects a flood of set-answer events and records it in /metrics", async () => {
    const { token } = await registerUser(app);
    const { quizId, questions } = await createPublishedQuiz(app, token, "Flood quiz", 1, 600);
    const { gameId, joinCode } = await createGame(app, token, quizId);
    const q1 = questions[0]!;

    const player = await joinPlayerAsCookie(app, joinCode, "bot");
    const host = ioc(live.base, { transports: ["websocket"], extraHeaders: { Cookie: `quiz_session=${token}` } });
    const sBot = ioc(live.base, { transports: ["websocket"], extraHeaders: { Cookie: player.cookie } });
    await Promise.all([waitFor(host, "connect"), waitFor(sBot, "connect")]);
    await sleep(400);

    host.emit("host:join-game", { gameId });
    await waitFor<{ phase: string }>(host, "host:state");
    const startedP = waitFor(host, "host:paper-started");
    host.emit("host:start-paper", { gameId });
    await startedP;

    const rejected: string[] = [];
    const accepted: number[] = [];
    sBot.on("player:set-answer-ack", (ack: { accepted: boolean; reason?: string }) => {
      if (!ack.accepted) rejected.push(ack.reason ?? "");
      accepted.push(ack.accepted ? 1 : 0);
    });

    for (let n = 0; n < 120; n++) {
      sBot.emit("player:set-answer", { gameId, questionId: q1.id, optionId: q1.correctOptionId });
    }
    await sleep(1500);

    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.some((r) => r.includes("Too many events"))).toBe(true);
    // The paper was active and the bucket accepts early events but never all 120.
    expect(accepted.filter(Boolean).length).toBeGreaterThan(0);
    expect(accepted.filter(Boolean).length).toBeLessThan(120);

    const metrics = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(metrics.body).toMatch(/quiz_ws_events_total\{event="player:set-answer"\} \d+/);
    expect(metrics.body).toMatch(/quiz_ws_rate_limited_total\{event="player:set-answer"\} \d+/);

    host.disconnect();
    sBot.disconnect();
  });
});