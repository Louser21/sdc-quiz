import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { getConfig } from "../config.js";
import { prisma } from "../db/client.js";

/**
 * Player identity is a persistent httpOnly cookie (NOT the socket id).
 * The raw token lives only in the cookie; the DB stores its sha256.
 * Redis state is addressed by playerId; the cookie grants recovery across
 * sockets, refreshes, and network switches.
 */
export function generatePlayerToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashPlayerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function cookieBase() {
  const config = getConfig();
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.NODE_ENV === "staging" || config.NODE_ENV === "production",
  };
}

export function setPlayerSessionCookie(reply: FastifyReply, token: string): void {
  const config = getConfig();
  reply.setCookie(config.PLAYER_SESSION_COOKIE_NAME, token, {
    ...cookieBase(),
    maxAge: 7 * 24 * 60 * 60, // reconnect window (matches Redis keepalive)
  });
}

export function clearPlayerSessionCookie(reply: FastifyReply): void {
  const config = getConfig();
  reply.clearCookie(config.PLAYER_SESSION_COOKIE_NAME, { ...cookieBase(), maxAge: 0 });
}

/** Resolve a player + their game from a raw cookie header (Socket.IO handshake). */
export async function resolvePlayerFromCookieHeader(
  cookieHeader: string | undefined,
): Promise<{ playerId: string; gameId: string; nickname: string; sessionId: string } | null> {
  if (!cookieHeader) return null;
  const config = getConfig();
  const raw = parseCookies(cookieHeader)[config.PLAYER_SESSION_COOKIE_NAME];
  if (!raw) return null;
  return resolvePlayerFromSessionToken(raw);
}

/** Resolve a player from a raw session token (validates format + DB lookup). */
export async function resolvePlayerFromSessionToken(
  raw: string,
): Promise<{ playerId: string; gameId: string; nickname: string; sessionId: string } | null> {
  const sessionId = hashPlayerToken(raw);
  const player = await prisma.player.findUnique({
    where: { sessionId },
    select: { id: true, gameId: true, nickname: true, sessionId: true },
  });
  if (!player) return null;
  return {
    playerId: player.id,
    gameId: player.gameId,
    nickname: player.nickname,
    sessionId: player.sessionId,
  };
}