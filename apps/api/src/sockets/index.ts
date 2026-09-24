import type { Server as HttpServer } from "node:http";
import { Server as IoServer } from "socket.io";
import { getConfig } from "../config.js";
import { getLogger } from "../logging/logger.js";
import { setupSocketServer } from "./handlers.js";

declare module "socket.io" {
  interface SocketData {
    /** resolved host user id, when the socket authenticated as a host */
    hostUserId?: string;
    /** resolved player row id, when the socket authenticated as a player */
    playerId?: string;
    /** resolved player session id, when the socket authenticated as a player */
    playerSessionId?: string;
    gameId?: string;
    connectAt: number;
  }
}

/**
 * Attach Socket.IO to the running HTTP server. Game logic (state machine,
 * rooms, answers) is layered on top of this in `sockets/handlers.ts`.
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

  io.on("connect_error", (err) => {
    logger.warn({ err: err.message }, "socket connect error");
  });

  // Wire all game event handlers + recovery.
  setupSocketServer(io);

  return io;
}