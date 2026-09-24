import type { Server as IoServer } from "socket.io";
import { SERVER_EVENTS, type ServerEventName, type ServerEventPayload } from "@quiz/shared";
import { getLogger } from "../logging/logger.js";

/**
 * Typed, validated outbound events (defense-in-depth on top of the TypeScript
 * types). A payload that fails its schema is dropped + logged — it must never
 * reach a client malformed.
 */
function validate<E extends ServerEventName>(name: E, payload: ServerEventPayload<E>): boolean {
  const schema = SERVER_EVENTS[name];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    getLogger().error(
      { event: name, issues: parsed.error.issues },
      "outbound socket event failed validation",
    );
    return false;
  }
  return true;
}

function emitChecked<E extends ServerEventName>(
  target: { emit: (name: string, payload: unknown) => void },
  name: E,
  payload: ServerEventPayload<E>,
): void {
  if (validate(name, payload)) {
    target.emit(name, payload);
  }
}

export const emitter =
  (io: IoServer) =>
  <E extends ServerEventName>(name: E, payload: ServerEventPayload<E>) => {
    emitChecked(io, name, payload);
  };

export const emitterToRoom =
  (io: IoServer) =>
  (room: string) =>
  <E extends ServerEventName>(name: E, payload: ServerEventPayload<E>) => {
    if (validate(name, payload)) {
      io.to(room).emit(name, payload);
    }
  };

export const emitterToSocket =
  (io: IoServer) =>
  (socketId: string) =>
  <E extends ServerEventName>(name: E, payload: ServerEventPayload<E>) => {
    if (validate(name, payload)) {
      io.to(socketId).emit(name, payload);
    }
  };