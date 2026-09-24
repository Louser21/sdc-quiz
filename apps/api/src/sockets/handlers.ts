import type { Server as IoServer, Socket } from "socket.io";
import { z } from "zod";
import { CLIENT_EVENTS, type ClientEventName, type ClientEventPayload } from "@quiz/shared";
import * as store from "../game/store.js";
import { buildHostState, buildPlayerState } from "../game/state.js";
import * as hostGame from "../game/host.js";
import * as playerGame from "../game/player.js";
import { resolvePlayerFromCookieHeader } from "../players/session.js";
import { resolveUserFromCookieHeader } from "../auth/plugin.js";
import { AppError, errors } from "../errors/index.js";
import { getLogger, logGame } from "../logging/logger.js";
import { gameRoom, hostRoom } from "./rooms.js";
import { emitterToRoom, emitterToSocket } from "./emitter.js";

/**
 * Game transport layer. All inbound events are runtime-validated, authorized,
 * and translated into `game/` service calls. Event flow:
 *
 *   client event  ->  validate + authorize  ->  game/host.ts | game/player.ts
 *                                                |
 *  server events (validated outbound)  <--------+
 */

/** Sockets that identify as a player in a game. */
function identifyPlayer(socket: Socket): { playerId: string; gameId: string } | null {
  if (socket.data.playerId && socket.data.gameId) {
    return { playerId: socket.data.playerId, gameId: socket.data.gameId };
  }
  return null;
}

function parseEvent(name: string, payload: unknown): unknown {
  const schema = (CLIENT_EVENTS as Record<string, z.ZodType>)[name];
  if (!schema) {
    throw errors.validation("Unknown event");
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw errors.validation(result.error.issues[0]?.message ?? "Invalid payload");
  }
  return result.data;
}

function sendAppError(io: IoServer, socket: Socket, err: unknown): void {
  const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
  const message = err instanceof Error ? err.message : "Internal error";
  if (!(err instanceof AppError)) {
    getLogger().error({ err: message, sid: socket.id }, "socket handler error");
  }
  emitterToSocket(io)(socket.id)("error", { code, message });
}

export function setupSocketServer(io: IoServer): void {
  const toRoom = emitterToRoom(io);
  const toSocket = emitterToSocket(io);

  const questionTimers = new Map<string, NodeJS.Timeout>();
  const answerCountTimers = new Map<string, NodeJS.Timeout>();
  const lastHeartbeat = new Map<string, number>();

  function clearQuestionTimer(gameId: string): void {
    const timer = questionTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      questionTimers.delete(gameId);
    }
  }

  function clearAllTimersFor(gameId: string): void {
    clearQuestionTimer(gameId);
    const ac = answerCountTimers.get(gameId);
    if (ac) {
      clearTimeout(ac);
      answerCountTimers.delete(gameId);
    }
  }

  /** Server-authoritative question end: results → per-player results → persistence. */
  async function endActiveQuestionFlow(gameId: string): Promise<void> {
    const outcome = await hostGame.endActiveQuestion(gameId);
    clearQuestionTimer(gameId);

    toRoom(hostRoom(gameId))("host:question-result", outcome.result);
    toRoom(gameRoom(gameId))("game:question-result", {
      questionId: outcome.result.questionId,
      correctOptionId: outcome.result.correctOptionId,
    });

    // Per-player personal results (their selection + points against the shared answer).
    const players = await store.getPlayers(gameId);
    const sockets = await io.in(gameRoom(gameId)).fetchSockets();
    const byPlayer = new Map<string, (typeof sockets)[number][]>();
    for (const s of sockets) {
      if (typeof s.data.playerId === "string") {
        const list = byPlayer.get(s.data.playerId) ?? [];
        list.push(s);
        byPlayer.set(s.data.playerId, list);
      }
    }
    for (const [playerId, list] of byPlayer) {
      const answer = outcome.answers.find((a) => a.playerId === playerId);
      const total = players[playerId]?.score ?? 0;
      const payload = {
        questionId: outcome.result.questionId,
        correctOptionId: outcome.result.correctOptionId,
        selectedOptionId: answer?.optionId ?? null,
        points: answer?.points ?? 0,
        isCorrect: answer !== undefined && answer.optionId === outcome.result.correctOptionId,
        totalPoints: total,
      };
      for (const s of list) {
        toSocket(s.id)("player:question-result", payload);
      }
    }

    logGame("QUESTION_RESULTS_SENT", {
      gameId,
      questionId: outcome.result.questionId,
      answerCount: outcome.result.answerCount,
    });
  }

  function scheduleQuestionTimer(gameId: string, endsAt: number): void {
    clearQuestionTimer(gameId);
    const delay = Math.max(0, endsAt - Date.now()) + 50;
    questionTimers.set(
      gameId,
      setTimeout(() => {
        questionTimers.delete(gameId);
        void endActiveQuestionFlow(gameId).catch((err) =>
          getLogger().error({ err: err instanceof Error ? err.message : String(err), gameId }, "auto end question failed"),
        );
      }, delay),
    );
  }

  /** Coalesce answer-count updates to the host (bursts of answers -> one event). */
  function scheduleAnswerCount(gameId: string, questionId: string, answerCount: number): void {
    const existing = answerCountTimers.get(gameId);
    if (existing) clearTimeout(existing);
    answerCountTimers.set(
      gameId,
      setTimeout(() => {
        answerCountTimers.delete(gameId);
        toRoom(hostRoom(gameId))("host:answer-count", { questionId, answerCount });
      }, 150),
    );
  }

  async function requireHostOwnedGame(
    socket: Socket,
    gameId: string,
  ): Promise<{
    state: store.GameStateRow;
    ownerName: string;
  }> {
    if (!socket.data.hostUserId) throw errors.unauthorized("Host authentication required");
    const state = await store.getState(gameId);
    if (!state) throw errors.invalidGameCode("Game is not available");
    if (state.hostUserId !== socket.data.hostUserId) throw errors.forbidden("Not the host of this game");
    return { state, ownerName: state.hostUserId };
  }

  /** Emit the question to both player and host rooms after a successful start. */
  async function broadcastStartedQuestion(gameId: string): Promise<void> {
    const state = await store.getState(gameId);
    if (!state?.currentQuestionId || !state.questionEndsAt) throw errors.questionNotActive();
    const questions = await store.getQuestions(gameId);
    const question = questions.list.find((q) => q.id === state.currentQuestionId);
    if (!question) throw errors.internal("Started question not in snapshot");

    toRoom(gameRoom(gameId))("game:question", {
      questionId: question.id,
      questionNumber: state.questionNumber,
      totalQuestions: state.totalQuestions,
      text: question.text,
      options: question.options.map((o) => ({ id: o.id, text: o.text })),
      timeLimit: question.timeLimit,
      questionEndsAt: state.questionEndsAt,
    });

    toRoom(hostRoom(gameId))("host:question-started", {
      questionId: question.id,
      questionNumber: state.questionNumber,
      totalQuestions: state.totalQuestions,
      text: question.text,
      timeLimit: question.timeLimit,
      questionStartedAt: state.questionStartedAt ?? 0,
      questionEndsAt: state.questionEndsAt,
      answerCount: 0,
    });

    scheduleQuestionTimer(gameId, state.questionEndsAt);
  }

  // -------------------------------------------------------------------------
  // Restart recovery: hand into any restored QUESTION_ACTIVE games the timers
  // that died with the previous process (state itself lives in Redis).
  // -------------------------------------------------------------------------
  async function restoreActiveTimers(): Promise<void> {
    try {
      const ids = await store.listLiveGameIds();
      for (const gameId of ids) {
        const state = await store.getState(gameId);
        if (!state) continue;
        if (state.phase === "QUESTION_ACTIVE" && state.questionEndsAt) {
          scheduleQuestionTimer(gameId, state.questionEndsAt);
          logGame("GAME_RESTORED", { gameId, questionId: state.currentQuestionId, endsAt: state.questionEndsAt });
        } else if (state.phase !== "FINISHED") {
          await store.setHostConnected(gameId, false);
        }
      }
    } catch (err) {
      getLogger().error({ err: err instanceof Error ? err.message : String(err) }, "restore active games failed");
    }
  }

  // -------------------------------------------------------------------------
  // Handshake-time authentication (runs before any event handler can fire, so
  // there is no race between `connection` and the first host/player events).
  // -------------------------------------------------------------------------
  io.use(async (socket, next) => {
    try {
      socket.data.connectAt = Date.now();
      const cookieHeader = socket.handshake.headers.cookie;
      const user = await resolveUserFromCookieHeader(cookieHeader);
      if (user) socket.data.hostUserId = user.id;
      const player = await resolvePlayerFromCookieHeader(cookieHeader);
      if (player) {
        socket.data.playerId = player.playerId;
        socket.data.playerSessionId = player.sessionId;
        socket.data.gameId = player.gameId;
      }
      next();
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), sid: socket.id },
        "socket handshake auth failed",
      );
      next(new Error("authentication failed"));
    }
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  io.on("connection", (socket) => {
    // Player identity: attach to the game room + mark present.
    if (socket.data.playerId && socket.data.gameId) {
      void (async () => {
        try {
          const playerId = socket.data.playerId as string;
          const gameId = socket.data.gameId as string;
          await socket.join(gameRoom(gameId));
          await store.setPlayerConnected(gameId, playerId, true);
          const record = await store.getPlayer(gameId, playerId);
          toRoom(hostRoom(gameId))("host:player-updated", {
            playerId,
            nickname: record?.nickname ?? "",
            connected: true,
          });
          await store.touchGame(gameId);
          logGame("PLAYER_CONNECTED", { gameId, playerId });
        } catch (err) {
          getLogger().warn(
            { err: err instanceof Error ? err.message : String(err), sid: socket.id },
            "player connection attach failed",
          );
        }
      })();
    }

    // --- Host events --------------------------------------------------------

    socket.on("host:join-game", async (payload: unknown) => {
      try {
        const data = parseEvent("host:join-game", payload) as ClientEventPayload<"host:join-game">;
        await requireHostOwnedGame(socket, data.gameId);
        await socket.join(hostRoom(data.gameId));
        socket.data.gameId = data.gameId;
        await store.setHostConnected(data.gameId, true);
        await store.touchGame(data.gameId);
        const view = await buildHostState(data.gameId);
        toSocket(socket.id)("host:state", view);
        logGame("HOST_CONNECTED", { gameId: data.gameId });
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:start-question", async (payload: unknown) => {
      try {
        const data = parseEvent("host:start-question", payload) as ClientEventPayload<"host:start-question">;
        await requireHostOwnedGame(socket, data.gameId);
        await hostGame.startQuestion(data.gameId, socket.data.hostUserId!, data.questionId);
        await broadcastStartedQuestion(data.gameId);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:next-question", async (payload: unknown) => {
      try {
        const data = parseEvent("host:next-question", payload) as ClientEventPayload<"host:next-question">;
        await requireHostOwnedGame(socket, data.gameId);
        const nextId = await hostGame.nextQuestionId(data.gameId);
        if (!nextId) {
          const out = await hostGame.finishGame(data.gameId, socket.data.hostUserId!);
          clearAllTimersFor(data.gameId);
          const payloadOut = {
            gameId: data.gameId,
            joinCode: out.joinCode,
            quizTitle: out.quizTitle,
            leaderboard: out.leaderboard,
          };
          toRoom(hostRoom(data.gameId))("host:game-finished", payloadOut);
          toRoom(gameRoom(data.gameId))("game:finished", payloadOut);
          logGame("GAME_FINISHED", { gameId: data.gameId });
          return;
        }
        await hostGame.startQuestion(data.gameId, socket.data.hostUserId!, nextId);
        await broadcastStartedQuestion(data.gameId);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:end-question", async (payload: unknown) => {
      try {
        const data = parseEvent("host:end-question", payload) as ClientEventPayload<"host:end-question">;
        await requireHostOwnedGame(socket, data.gameId);
        await endActiveQuestionFlow(data.gameId);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:end-game", async (payload: unknown) => {
      try {
        const data = parseEvent("host:end-game", payload) as ClientEventPayload<"host:end-game">;
        await requireHostOwnedGame(socket, data.gameId);
        const out = await hostGame.finishGame(data.gameId, socket.data.hostUserId!);
        clearAllTimersFor(data.gameId);
        const payloadOut = { gameId: data.gameId, joinCode: out.joinCode, quizTitle: out.quizTitle, leaderboard: out.leaderboard };
        toRoom(hostRoom(data.gameId))("host:game-finished", payloadOut);
        toRoom(gameRoom(data.gameId))("game:finished", payloadOut);
        logGame("GAME_FINISHED", { gameId: data.gameId });
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:sync", async (_payload: unknown) => {
      try {
        parseEvent("host:sync", {});
        if (!socket.data.hostUserId || !socket.data.gameId) {
          toSocket(socket.id)("error", { code: "HOST_NOT_IN_GAME", message: "Join a game room first" });
          return;
        }
        const view = await buildHostState(socket.data.gameId);
        toSocket(socket.id)("host:state", view);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    // --- Player events ------------------------------------------------------

    socket.on("player:submit-answer", async (payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) {
        toSocket(socket.id)("player:answer-ack", {
          questionId: (payload as { questionId?: string })?.questionId ?? "",
          accepted: false,
          reason: "Your session is not attached to a game",
          answerCount: 0,
        });
        return;
      }
      try {
        const data = parseEvent("player:submit-answer", payload) as ClientEventPayload<"player:submit-answer">;
        if (data.gameId !== identity.gameId) throw errors.invalidGameCode("Wrong game");
        const out = await playerGame.submitAnswer(identity.gameId, identity.playerId, data.questionId, data.optionId);
        toSocket(socket.id)("player:answer-ack", {
          questionId: out.questionId,
          accepted: true,
          answerCount: out.answerCount,
        });
        scheduleAnswerCount(identity.gameId, data.questionId, out.answerCount);
        logGame("ANSWER_ACCEPTED", { gameId: identity.gameId, playerId: identity.playerId, questionId: data.questionId, points: out.points });
      } catch (err) {
        const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
        const message = err instanceof Error ? err.message : "Internal error";
        toSocket(socket.id)("player:answer-ack", {
          questionId: (payload as { questionId?: string })?.questionId ?? "",
          accepted: false,
          reason: message,
          answerCount: 0,
        });
        logGame("ANSWER_REJECTED", { gameId: identity.gameId, playerId: identity.playerId, reason: code });
      }
    });

    socket.on("player:sync", async (_payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) {
        toSocket(socket.id)("error", { code: "NOT_IN_GAME", message: "Join a game first" });
        return;
      }
      try {
        parseEvent("player:sync", {});
        const view = await buildPlayerState(identity.gameId, identity.playerId);
        toSocket(socket.id)("player:state", view);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("player:heartbeat", async (_payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) return;
      const now = Date.now();
      const last = lastHeartbeat.get(identity.playerId) ?? 0;
      if (now - last < 5_000) return;
      lastHeartbeat.set(identity.playerId, now);
      try {
        await store.setPlayerConnected(identity.gameId, identity.playerId, true);
      } catch (err) {
        getLogger().warn({ err: err instanceof Error ? err.message : String(err), playerId: identity.playerId }, "heartbeat failed");
      }
    });

    socket.on("player:join", async (_payload: unknown) => {
      // Joining requires the httpOnly player cookie, which Socket.IO cannot set.
      // Always go through POST /api/play/join first (REST), then reconnect.
      toSocket(socket.id)("error", {
        code: "JOIN_VIA_REST",
        message: "Join through the game join page (setPlayerSessionCookie)",
      });
    });

    // --- Disconnect ---------------------------------------------------------

    socket.on("disconnect", () => {
      const identity = identifyPlayer(socket);
      if (identity) {
        void (async () => {
          try {
            const sockets = await io.in(gameRoom(identity.gameId)).fetchSockets();
            const samePlayer = sockets.filter((s) => s.data.playerId === identity.playerId && s.id !== socket.id);
            if (samePlayer.length === 0) {
              await store.setPlayerConnected(identity.gameId, identity.playerId, false);
            }
            const record = await store.getPlayer(identity.gameId, identity.playerId);
            toRoom(hostRoom(identity.gameId))("host:player-updated", {
              playerId: identity.playerId,
              nickname: record?.nickname ?? "",
              connected: samePlayer.length > 0,
            });
            logGame("PLAYER_DISCONNECTED", { gameId: identity.gameId, playerId: identity.playerId });
          } catch (err) {
            getLogger().warn({ err: err instanceof Error ? err.message : String(err), sid: socket.id }, "disconnect cleanup failed");
          }
        })();
      }
      if (socket.data.hostUserId && socket.data.gameId) {
        void (async () => {
          try {
            const hostSockets = await io.in(hostRoom(socket.data.gameId!)).fetchSockets();
            const sameHost = hostSockets.filter((s) => s.data.hostUserId === socket.data.hostUserId && s.id !== socket.id);
            if (sameHost.length === 0) {
              await store.setHostConnected(socket.data.gameId!, false);
              logGame("HOST_DISCONNECTED", { gameId: socket.data.gameId });
            }
          } catch (err) {
            getLogger().warn({ err: err instanceof Error ? err.message : String(err), sid: socket.id }, "host disconnect cleanup failed");
          }
        })();
      }
      logGame("SOCKET_DISCONNECTED", { sid: socket.id });
    });
  });

  // Wire restore into startup so timers survive a backend restart.
  void restoreActiveTimers();
}