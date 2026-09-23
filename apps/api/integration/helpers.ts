import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";

export const TEST_SESSION_COOKIE = "quiz_session";

export async function startTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Extract the raw session cookie value from a response's set-cookie header. */
export function extractSessionCookie(resp: LightMyRequestResponse): string {
  const setCookie = resp.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error("Response did not set a session cookie");
  const match = /quiz_session=([^;]+)/.exec(header);
  if (!match) throw new Error("quiz_session cookie not found in set-cookie");
  return match[1] ?? "";
}

export function withCookie(token: string): { cookies: Record<string, string> } {
  return { cookies: { [TEST_SESSION_COOKIE]: token } };
}

export async function registerUser(
  app: FastifyInstance,
  overrides: Partial<{ email: string; name: string; password: string }> = {},
): Promise<{ token: string; user: { id: string; email: string; name: string; role: string } }> {
  const base = `test-${Math.random().toString(36).slice(2, 10)}`;
  const resp = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: overrides.email ?? `${base}@example.com`,
      name: overrides.name ?? "Tester",
      password: overrides.password ?? "password123",
    },
  });
  if (resp.statusCode !== 201) throw new Error(`register failed: ${resp.body}`);
  return { token: extractSessionCookie(resp), user: JSON.parse(resp.body).user };
}

/** Wipe all app tables. Call in beforeEach() when isolation is required. */
export async function resetDb(): Promise<void> {
  const { prisma } = await import("../src/db/client.js");
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Answer", "Player", "GameSession", "Quiz", "Question", "Option", "Session", "User" CASCADE;',
  );
}