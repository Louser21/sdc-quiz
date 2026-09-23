import type { IoServer } from "./index.js";

let io: IoServer | undefined;

export function setIo(server: IoServer): void {
  io = server;
}

export function getIo(): IoServer {
  if (!io) throw new Error("Socket.IO server not initialized");
  return io;
}