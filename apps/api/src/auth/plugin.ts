import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { getConfig } from "../config.js";
import { prisma } from "../db/client.js";
import { AppError } from "../errors/index.js";
import { hashSessionToken, generateSessionToken } from "./tokens.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "HOST" | "ADMIN";
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

function cookieBase(config: ReturnType<typeof getConfig>) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.NODE_ENV === "staging" || config.NODE_ENV === "production",
  };
}

export function sessionCookieMaxAgeSeconds(): number {
  return getConfig().SESSION_TTL_DAYS * 24 * 60 * 60;
}

async function resolveUser(req: FastifyRequest): Promise<AuthUser | null> {
  const config = getConfig();
  const raw = req.cookies[config.SESSION_COOKIE_NAME];
  if (!raw) return null;
  return resolveUserFromToken(raw);
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

/** Resolve the host user from a raw Cookie header (for Socket.IO handshakes). */
export async function resolveUserFromCookieHeader(
  cookieHeader: string | undefined,
): Promise<AuthUser | null> {
  const config = getConfig();
  if (!cookieHeader) return null;
  const raw = parseCookies(cookieHeader)[config.SESSION_COOKIE_NAME];
  if (!raw) return null;
  return resolveUserFromToken(raw);
}

async function resolveUserFromToken(raw: string): Promise<AuthUser | null> {
  const tokenHash = hashSessionToken(raw);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true, email: true, name: true, role: true } },
    },
  });
  if (!session || session.revokedAt !== null || session.expiresAt.getTime() < Date.now()) {
    return null;
  }
  // Lazily refresh lastUsedAt (bounded writes).
  if (Date.now() - session.lastUsedAt.getTime() > 5 * 60_000) {
    void prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const config = getConfig();
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    ...cookieBase(config),
    maxAge: sessionCookieMaxAgeSeconds(),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  const config = getConfig();
  reply.clearCookie(config.SESSION_COOKIE_NAME, { ...cookieBase(config), maxAge: 0 });
}

/**
 * Create a DB-backed session row for a user and return the raw token (which is
 * only ever placed into an httpOnly cookie).
 */
export async function createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<string> {
  const token = generateSessionToken();
  await prisma.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt: new Date(Date.now() + sessionCookieMaxAgeSeconds() * 1000),
      ip: meta.ip?.slice(0, 64) ?? null,
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
    },
  });
  return token;
}

export async function destroySession(req: FastifyRequest): Promise<void> {
  const config = getConfig();
  const raw = req.cookies[config.SESSION_COOKIE_NAME];
  if (!raw) return;
  await prisma.session
    .updateMany({
      where: { tokenHash: hashSessionToken(raw) },
      data: { revokedAt: new Date() },
    })
    .catch(() => undefined);
}

export function requireAuth(req: FastifyRequest): AuthUser {
  if (req.user === null) throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  return req.user;
}

/**
 * Auth plugin: resolves `request.user` from the httpOnly session cookie for
 * every request, and provides helpers used by the routes below.
 */
export const authPlugin = fp(async (app) => {
  app.addHook("onRequest", async (req) => {
    req.user = await resolveUser(req);
  });
});