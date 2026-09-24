"use client";

import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@quiz/shared";

export type QuizSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: QuizSocket | null = null;

/**
 * One shared socket per page. `origin` is the API origin (set via
 * NEXT_PUBLIC_SOCKET_URL when the web app is served from a different origin,
 * e.g. Next dev on :3002 against the API on :3001). Empty string = same origin.
 * Start HTTPS requests are proxied to the API or served same-origin behind nginx.
 */
export function getSocket(): QuizSocket {
  if (!socket) {
    const origin = process.env.NEXT_PUBLIC_SOCKET_URL ?? "";
    socket = io(origin, {
      path: "/socket.io",
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

export function dropSocket(): void {
  socket?.disconnect();
  socket = null;
}