import type { Server as IoServer, Socket } from "socket.io";
import { z } from "zod";
import { CLIENT_EVENTS, type ClientEventPayload } from "@quiz/shared";
import * as store from "../game/store.js";
import { buildHostState, buildPlayerState } from "../game/state.js";
import * as hostGame from "../game/host.js";
import * as playerGame from "../game/player.js";
import { resolvePlayerFromCookieHeader } from "../players/session.js";
import { resolveUserFromCookieHeader } from "../auth/plugin.js";
import { AppError, errors } from "../errors/index.js";
import { getLogger, logGame } from "../logging/logger.js";
import { countWsEvent, countWsRateLimited } from "../observability/metrics.js";
import { gameRoom, hostRoom } from "./rooms.js";
import { emitterToRoom, emitterToSocket } from "./emitter.js";
import { hostActionBucket, playerActionBucket } from "./token-bucket.js";

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
  countWsEvent(name);
  return result.data;
}

/** Emit a RATE_LIMITED error; skips the work the event would have triggered. */
function rateLimited(io: IoServer, socket: Socket, event: string): void {
  countWsRateLimited(event);
  emitterToSocket(io)(socket.id)("error", { code: "RATE_LIMITED", message: "Too many events, slow down" });
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

  const paperTimers = new Map<string, NodeJS.Timeout>();
  const lastHeartbeat = new Map<string, number>();

  function clearPaperTimer(gameId: string): void {
    const timer = paperTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      paperTimers.delete(gameId);
    }
  }

  /** Server-authoritative paper end: auto-submit all, score, FINISHED, persist. */
  async function finalizePaperFlow(gameId: string): Promise<void> {
    const outcome = await hostGame.finalizePaper(gameId);
    clearPaperTimer(gameId);

    const finishedPayload = {
      gameId,
      joinCode: outcome.joinCode,
      quizTitle: outcome.quizTitle,
      leaderboard: outcome.leaderboard,
    };
    toRoom(hostRoom(gameId))("host:game-finished", finishedPayload);
    toRoom(gameRoom(gameId))("game:finished", finishedPayload);

    await pushPlayerStates(gameId);

    logGame("PAPER_FINISHED", {
      gameId,
      submitted: outcome.papers.length,
      leaderSize: outcome.leaderboard.length,
    });
  }

  function schedulePaperTimer(gameId: string, deadline: number): void {
    clearPaperTimer(gameId);
    const delay = Math.max(0, deadline - Date.now()) + 50;
    paperTimers.set(
      gameId,
      setTimeout(() => {
        paperTimers.delete(gameId);
        void finalizePaperFlow(gameId).catch((err) =>
          getLogger().error({ err: err instanceof Error ? err.message : String(err), gameId }, "auto finalize paper failed"),
        );
      }, delay),
    );
  }

  /** Re-send the latest server view to every connected player's sockets. */
  async function pushPlayerStates(gameId: string): Promise<void> {
    const sockets = await io.in(gameRoom(gameId)).fetchSockets();
    const byPlayer = new Map<string, typeof sockets>();
    for (const s of sockets) {
      if (typeof s.data.playerId === "string") {
        const list = byPlayer.get(s.data.playerId) ?? [];
        list.push(s);
        byPlayer.set(s.data.playerId, list);
      }
    }
    for (const playerId of byPlayer.keys()) {
      try {
        const view = await buildPlayerState(gameId, playerId);
        for (const s of byPlayer.get(playerId) ?? []) {
          toSocket(s.id)("player:state", view);
        }
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), gameId, playerId },
          "push player state failed",
        );
      }
    }
  }

  async function requireHostOwnedGame(
    socket: Socket,
    gameId: string,
  ): Promise<{ state: store.GameStateRow; ownerName: string }> {
    if (!socket.data.hostUserId) throw errors.unauthorized("Host authentication required");
    const state = await store.getState(gameId);
    if (!state) throw errors.invalidGameCode("Game is not available");
    if (state.hostUserId !== socket.data.hostUserId) throw errors.forbidden("Not the host of this game");
    return { state, ownerName: state.hostUserId };
  }

  // -------------------------------------------------------------------------
  // Restart recovery: hand restored ACTIVE games their deadline timers (state
  // itself lives in Redis and survives the restart).
  // -------------------------------------------------------------------------
  async function restoreActiveTimers(): Promise<void> {
    try {
      const ids = await store.listLiveGameIds();
      for (const gameId of ids) {
        const state = await store.getState(gameId);
        if (!state) continue;
        if (state.phase === "ACTIVE" && state.deadline) {
          schedulePaperTimer(gameId, state.deadline);
          logGame("GAME_RESTORED", { gameId, deadline: state.deadline });
        } else if (state.phase !== "FINISHED" && state.phase !== "ACTIVE") {
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
            submitted: record?.submitted ?? false,
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
        if (!hostActionBucket.take(`join:${data.gameId}`)) {
          rateLimited(io, socket, "host:join-game");
          return;
        }
        await requireHostOwnedGame(socket, data.gameId);
        await socket.join(hostRoom(data.gameId));
        socket.data.gameId = data.gameId;
        await store.setHostConnected(data.gameId, true);
        await store.touchGame(data.gameId);
        const view = await buildHostState(data.gameId);
        toSocket(socket.id)("host:state", view);
        if (data.runId) logGame("HOST_CONNECTED", { gameId: data.gameId });
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:start-paper", async (payload: unknown) => {
      try {
        const data = parseEvent("host:start-paper", payload) as ClientEventPayload<"host:start-paper">;
        if (!hostActionBucket.take(`start:${data.gameId}`)) {
          rateLimited(io, socket, "host:start-paper");
          return;
        }
        await requireHostOwnedGame(socket, data.gameId);
        const { state } = await hostGame.startPaper(data.gameId, socket.data.hostUserId!);
        schedulePaperTimer(data.gameId, state.deadline!);
        toRoom(hostRoom(data.gameId))("host:paper-started", {
          gameId: data.gameId,
          timeLimitSeconds: state.timeLimitSeconds,
          paperStartedAt: state.paperStartedAt!,
          deadline: state.deadline!,
        });
        await pushPlayerStates(data.gameId);
        logGame("PAPER_STARTED", { gameId: data.gameId, deadline: state.deadline });
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:end-paper", async (payload: unknown) => {
      try {
        const data = parseEvent("host:end-paper", payload) as ClientEventPayload<"host:end-paper">;
        if (!hostActionBucket.take(`end:${data.gameId}`)) {
          rateLimited(io, socket, "host:end-paper");
          return;
        }
        await requireHostOwnedGame(socket, data.gameId);
        await hostGame.endPaper(data.gameId, socket.data.hostUserId!);
        await finalizePaperFlow(data.gameId);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("host:sync", async (payload: unknown) => {
      try {
        parseEvent("host:sync", payload ?? {});
        if (!socket.data.hostUserId || !socket.data.gameId) {
          toSocket(socket.id)("error", { code: "HOST_NOT_IN_GAME", message: "Join a game room first" });
          return;
        }
        await requireHostOwnedGame(socket, socket.data.gameId);
        const view = await buildHostState(socket.data.gameId);
        toSocket(socket.id)("host:state", view);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    // --- Player events ------------------------------------------------------

    socket.on("player:set-answer", async (payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) {
        const raw = payload as { questionId?: string; optionId?: string };
        toSocket(socket.id)("player:set-answer-ack", {
          questionId: raw.questionId ?? "",
          optionId: raw.optionId ?? "",
          accepted: false,
          reason: "Your session is not attached to a game",
        });
        return;
      }
      if (!playerActionBucket.take(identity.playerId)) {
        countWsRateLimited("player:set-answer");
        const raw = payload as { questionId?: string; optionId?: string };
        toSocket(socket.id)("player:set-answer-ack", {
          questionId: raw.questionId ?? "",
          optionId: raw.optionId ?? "",
          accepted: false,
          reason: "Too many events, slow down",
        });
        return;
      }
      try {
        const data = parseEvent("player:set-answer", payload) as ClientEventPayload<"player:set-answer">;
        if (data.gameId !== identity.gameId) throw errors.invalidGameCode("Wrong game");
        await playerGame.setAnswer(identity.gameId, identity.playerId, data.questionId, data.optionId);
        toSocket(socket.id)("player:set-answer-ack", {
          questionId: data.questionId,
          optionId: data.optionId,
          accepted: true,
        });
        logGame("SELECTION_SET", {
          gameId: identity.gameId,
          playerId: identity.playerId,
          questionId: data.questionId,
        });
      } catch (err) {
        const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
        const message = err instanceof Error ? err.message : "Internal error";
        const raw = payload as { questionId?: string; optionId?: string };
        toSocket(socket.id)("player:set-answer-ack", {
          questionId: raw.questionId ?? "",
          optionId: raw.optionId ?? "",
          accepted: false,
          reason: message,
        });
        logGame("SELECTION_REJECTED", { gameId: identity.gameId, playerId: identity.playerId, reason: code });
      }
    });

    socket.on("player:mark-review", async (payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) {
        toSocket(socket.id)("error", { code: "NOT_IN_GAME", message: "Join a game first" });
        return;
      }
      if (!playerActionBucket.take(identity.playerId)) {
        rateLimited(io, socket, "player:mark-review");
        return;
      }
      try {
        const data = parseEvent("player:mark-review", payload) as ClientEventPayload<"player:mark-review">;
        if (data.gameId !== identity.gameId) throw errors.invalidGameCode("Wrong game");
        await playerGame.setMarked(identity.gameId, identity.playerId, data.questionId, data.marked);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("player:submit-paper", async (payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) {
        toSocket(socket.id)("error", { code: "NOT_IN_GAME", message: "Join a game first" });
        return;
      }
      if (!playerActionBucket.take(identity.playerId)) {
        rateLimited(io, socket, "player:submit-paper");
        return;
      }
      try {
        const data = parseEvent("player:submit-paper", payload) as ClientEventPayload<"player:submit-paper">;
        if (data.gameId !== identity.gameId) throw errors.invalidGameCode("Wrong game");
        const { scorecard } = await playerGame.submitPaper(identity.gameId, identity.playerId);
        toSocket(socket.id)("player:scorecard", scorecard);

        const record = await store.getPlayer(identity.gameId, identity.playerId);
        const state = await store.getState(identity.gameId);
        const players = await store.getPlayers(identity.gameId);
        const submittedCount = Object.values(players).filter((p) => p.submitted).length;
        toRoom(hostRoom(identity.gameId))("host:player-submitted", {
          playerId: identity.playerId,
          nickname: record?.nickname ?? "",
          submittedCount,
        });
        await pushPlayerStates(identity.gameId);

        // Natural end: everyone who joined has submitted.
        const total = Object.keys(players).length;
        if (total > 0 && submittedCount >= total && state?.phase === "ACTIVE") {
          await finalizePaperFlow(identity.gameId);
        }
        logGame("PAPER_SUBMITTED", { gameId: identity.gameId, playerId: identity.playerId });
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("player:sync", async (payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) {
        toSocket(socket.id)("error", { code: "NOT_IN_GAME", message: "Join a game first" });
        return;
      }
      try {
        parseEvent("player:sync", payload ?? {});
        const view = await buildPlayerState(identity.gameId, identity.playerId);
        toSocket(socket.id)("player:state", view);
      } catch (err) {
        sendAppError(io, socket, err);
      }
    });

    socket.on("player:heartbeat", async (payload: unknown) => {
      const identity = identifyPlayer(socket);
      if (!identity) return;
      if (!playerActionBucket.take(identity.playerId)) return;
      try {
        parseEvent("player:heartbeat", payload ?? {});
      } catch {
        return;
      }
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
              submitted: record?.submitted ?? false,
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