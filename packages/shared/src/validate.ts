import { CLIENT_EVENTS, type ClientEventName } from "./events.js";

/**
 * Validate an inbound client event by name + payload.
 * Returns the parsed payload or throws a zod error for unknown/ill-shaped events.
 */
export function parseClientEvent(name: string, payload: unknown): unknown {
  const schema = (CLIENT_EVENTS as Record<string, { parse: (v: unknown) => unknown }>)[name];
  if (!schema) {
    throw new Error(`Unknown client event: ${name}`);
  }
  return schema.parse(payload);
}

export function isClientEventName(name: string): name is ClientEventName {
  return Object.prototype.hasOwnProperty.call(CLIENT_EVENTS, name);
}