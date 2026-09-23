import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, resetDb, startTestApp, withCookie } from "./helpers.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await startTestApp();
  await resetDb();
});
afterAll(async () => {
  await app.close();
});

describe("auth", () => {
  it("registers a user and sets a session cookie", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "new@example.com", name: "New", password: "password123" },
    });
    expect(resp.statusCode).toBe(201);
    expect(JSON.parse(resp.body).user.email).toBe("new@example.com");
    expect(resp.headers["set-cookie"]).toMatch(/quiz_session=/);
    expect(resp.headers["set-cookie"]).toMatch(/HttpOnly/);
  });

  it("rejects duplicate registration with 409", async () => {
    await registerUser(app, { email: "dup@example.com" });
    const resp = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "dup@example.com", name: "Dup", password: "password123" },
    });
    expect(resp.statusCode).toBe(409);
  });

  it("rejects weak passwords and invalid emails", async () => {
    const weak = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "weak@example.com", name: "Weak", password: "short" },
    });
    expect(weak.statusCode).toBe(400);

    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", name: "Bad", password: "password123" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    const { user } = await registerUser(app, { email: "login@example.com", password: "password123" });

    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "login@example.com", password: "password123" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["set-cookie"]).toMatch(/quiz_session=/);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "login@example.com", password: "wrong-password" },
    });
    expect(wrong.statusCode).toBe(401);

    expect(user.email).toBe("login@example.com");
  });

  it("requires auth for /auth/me and returns the user when authenticated", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(anon.statusCode).toBe(401);

    const { token, user } = await registerUser(app);
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      ...withCookie(token),
    });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).user.id).toBe(user.id);
  });

  it("logout revokes the session", async () => {
    const { token } = await registerUser(app);
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      ...withCookie(token),
    });
    expect(out.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", ...withCookie(token) });
    expect(me.statusCode).toBe(401);
  });
});