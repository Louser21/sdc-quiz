import type { Server as HttpServer } from "node:http";
import { Server as IoServer } from "socket.io";
import { getConfig } from "../config.js";
import { getLogger } from "../logging/logger.js";

declare module "socket.io" {
  interface SocketData {
    /** resolved host user id, when the socket authenticated as a host */
    hostUserId?: string;
    /** resolved player session id, when the socket authenticated as a player */
    playerSessionId?: string;
    gameId?: string;
    connectAt: number;
  }
}

/**
 * Attach Socket.IO to the running HTTP server. Game logic (state machine,
 * rooms, answers) is layered on top of this in `game/` and `sockets/handlers`.
 */
export function attachSockets(server: HttpServer): IoServer {
  const config = getConfig();
  const io = new IoServer(server, {
    path: "/socket.io",
    serveClient: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectionStateRecovery: {
      // Allow a socket to resume a session even across transport drops for 2 minutes.
      maxDisconnectionDuration: 120_000,
    },
    cors: {
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  const logger = getLogger();

  io.on("connection", (socket) => {
    socket.data.connectAt = Date.now();
    socket.on("player:heartbeat", () => {
      // App-level presence heartbeat. Phase 3 updates player presence here.
    });

    socket.on("disconnect", () => {
      logger.info({ sid: socket.id, reason: socket.handshake?.auth?.reason }, "socket disconnected");
    });
  });

  io.on("connect_error", (err) => {
    logger.warn({ err: err.message }, "socket connect error");
  });

  return io;
}