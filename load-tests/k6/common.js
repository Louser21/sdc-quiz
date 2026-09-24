// Shared helpers for the k6 Socket.IO load tests.
// Socket.IO is driven over raw Engine.IO v4 WebSocket transport with k6/ws
// (no custom k6 binary required). Identity comes from the httpOnly cookies set
// by POST /api/play/join, so every VU performs the HTTP join first.
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

export const URL_BASE = __ENV.URL || "http://localhost:8080";
export const WS_BASE = URL_BASE.replace(/^http/, "ws");

export const K6_PLAYER = 0;
export const K6_HOST = 1;

export const metrics = {
  connect: new Trend("ws_connect_ms", true),
  sync_ready: new Trend("ws_first_state_ms", true),
  answer: new Trend("ws_answer_ack_ms", true),
  submit: new Trend("ws_submit_scorecard_ms", true),
  connect_failures: new Counter("ws_connect_failures"),
  rate_limited: new Counter("ws_rate_limited"),
};

/**
 * Register a host, create+fill+publish a quiz, and create a game.
 * Returns { hostCookie, gameId, joinCode, quizId }.
 */
export function seedHostAndGame(timeLimitSeconds) {
  const base = http.request;
  const email = `k6-host-${__ENV.URL_HASH || "smoke"}-${Date.now()}@load.test`;

  let res = http.post(`${URL_BASE}/api/auth/register`, JSON.stringify({
    name: "K6 Host",
    email,
    password: "k6-load-pass-123",
  }), { headers: { "Content-Type": "application/json" }, tags: { name: "register" } });
  if (res.status !== 201) return fail(res, "register");

  const hostCookie = res.cookies; // k6 object; stringify per-cookie
  const cookieHeader = Object.keys(hostCookie)
    .map((k) => `${k}=${hostCookie[k][0].value}`)
    .join("; ");
  const authHeaders = {
    "Content-Type": "application/json",
    Cookie: cookieHeader,
  };

  res = http.post(`${URL_BASE}/api/quizzes`, JSON.stringify({
    title: "K6 Load Quiz",
    timeLimitSeconds,
  }), { headers: authHeaders, tags: { name: "create_quiz" } });
  if (res.status !== 201) return fail(res, "create_quiz");
  const quizId = res.json().quiz.id;

  res = http.post(`${URL_BASE}/api/quizzes/${quizId}/questions`, JSON.stringify({
    text: "Load test question?",
    options: [
      { text: "A1", isCorrect: true },
      { text: "A2", isCorrect: false },
      { text: "A3", isCorrect: false },
      { text: "A4", isCorrect: false },
    ],
  }), { headers: authHeaders, tags: { name: "add_question" } });
  if (res.status !== 200) return fail(res, "add_question");

  res = http.post(`${URL_BASE}/api/quizzes/${quizId}/publish`, JSON.stringify({}), {
    headers: authHeaders,
    tags: { name: "publish" },
  });
  if (res.status !== 200) return fail(res, "publish");

  res = http.post(`${URL_BASE}/api/games`, JSON.stringify({ quizId }), {
    headers: authHeaders,
    tags: { name: "create_game" },
  });
  if (res.status !== 201) return fail(res, "create_game");

  return { cookieHeader, gameId: res.json().game.id, joinCode: res.json().game.joinCode };
}

/** Play-join as a fresh player. Returns { cookieHeader, gameId } or null. */
export function joinGame(code, nickname) {
  const nick = `${nickname}-${Date.now()}`; // unique per run (server enforces per-game uniqueness)
  const res = http.post(`${URL_BASE}/api/play/join`, JSON.stringify({
    gameCode: code,
    nickname: nick,
  }), { headers: { "Content-Type": "application/json" }, tags: { name: "play_join" } });
  check(res, { "play/join 200": (r) => r.status === 200 });
  if (res.status !== 200) return null;
  const cookieHeader = Object.keys(res.cookies)
    .map((k) => `${k}=${res.cookies[k][0].value}`)
    .join("; ");
  return { cookieHeader, gameId: res.json().join.gameId };
}

/**
 * Open a Socket.IO ws to the given URL, handshake Engine.IO, and run `loop`.
 * loop(socket, { onState, onAck }) parity — return an object of named callbacks.
 */
export function connectSocketio(hostCookie, handlers) {
  const url = `${WS_BASE}/socket.io/?EIO=4&transport=websocket`;
  const params = {
    headers: { Cookie: hostCookie },
    tags: { name: "socketio_connect" },
  };

  const t0 = Date.now();
  const present = {};
  return ws.connect(url, params, (socket) => {
    let engineOpen = false;
    let sioUp = false;

    socket.on("open", () => {
      // engine.io sends "0{...}" open packet first; nothing to do until message.
    });

    socket.on("message", (raw) => {
      const data = raw.toString();
      if (!engineOpen) {
        if (data[0] === "0") {
          engineOpen = true;
          // Complete the Socket.IO connect handshake.
          socket.send("40");
        }
        return;
      }
      if (!sioUp) {
        if (data[0] === "4" && data[1] === "0") {
          sioUp = true;
          metrics.connect.add(Date.now() - t0);
          if (handlers.onOpen) handlers.onOpen(socket);
          if (present.onOpen) present.onOpen(socket);
        }
        return;
      }
      // "42[\"event\",payload]" is a Socket.IO event message.
      if (data[0] === "4" && data[1] === "2") {
        try {
          const [event, payload] = JSON.parse(data.slice(2));
          if (handlers[event]) handlers[event](payload, socket);
          if (present[event]) present[event](payload, socket);
        } catch (e) {
          // ignore malformed frames during close
        }
        return;
      }
      if (handlers.onOther) handlers.onOther(data, socket);
    });

    socket.on("error", () => {
      metrics.connect_failures.add(1);
    });

    socket.setTimeout(() => {
      socket.close();
    }, 30_000);
  });
}

/** Forward a k6/ws Socket.IO emit: '42["event",<json>]'. */
export function emit(socket, event, payload) {
  socket.send(`42["${event}",${JSON.stringify(payload)}]`);
}

/** True when a payload carries a rate-limit error packet. */
export function isRateLimited(payload) {
  return Boolean(payload && payload.error && payload.error.code === "RATE_LIMITED");
}

function fail(res, step) {
  console.log(`[seed] ${step} failed: ${res.status} ${res.body}`);
  return null;
}

export const OPTION_FIRST = true;
export const sleepSec = sleep;