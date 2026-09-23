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

async function createQuiz(token: string, title = "My Quiz") {
  const resp = await app.inject({
    method: "POST",
    url: "/api/quizzes",
    payload: { title, description: "desc" },
    ...withCookie(token),
  });
  expect(resp.statusCode).toBe(201);
  return JSON.parse(resp.body).quiz as { id: string; title: string; status: string };
}

describe("quiz CRUD", () => {
  it("requires authentication", async () => {
    const resp = await app.inject({ method: "GET", url: "/api/quizzes" });
    expect(resp.statusCode).toBe(401);
  });

  it("creates and lists quizzes for the owner only", async () => {
    const { token } = await registerUser(app);
    const { token: otherToken } = await registerUser(app);
    await createQuiz(token, "Mine");

    const mine = await app.inject({
      method: "GET",
      url: "/api/quizzes",
      ...withCookie(token),
    });
    const theirs = await app.inject({
      method: "GET",
      url: "/api/quizzes",
      ...withCookie(otherToken),
    });
    expect(JSON.parse(mine.body).quizzes).toHaveLength(1);
    expect(JSON.parse(theirs.body).quizzes).toHaveLength(0);
  });

  it("validates quiz input", async () => {
    const { token } = await registerUser(app);
    const resp = await app.inject({
      method: "POST",
      url: "/api/quizzes",
      payload: { title: "" },
      ...withCookie(token),
    });
    expect(resp.statusCode).toBe(400);
  });

  it("forbids editing another user's quiz", async () => {
    const { token } = await registerUser(app);
    const { token: otherToken } = await registerUser(app);
    const quiz = await createQuiz(token);
    const resp = await app.inject({
      method: "PATCH",
      url: `/api/quizzes/${quiz.id}`,
      payload: { title: "Hacked" },
      ...withCookie(otherToken),
    });
    expect(resp.statusCode).toBe(403);
  });

  it("updates, publishes and duplicates a quiz", async () => {
    const { token } = await registerUser(app);
    const quiz = await createQuiz(token);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/quizzes/${quiz.id}`,
      payload: { title: "Renamed" },
      ...withCookie(token),
    });
    expect(JSON.parse(updated.body).quiz.title).toBe("Renamed");

    const published = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quiz.id}/publish`,
      ...withCookie(token),
    });
    expect(JSON.parse(published.body).quiz.status).toBe("PUBLISHED");

    const dup = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quiz.id}/duplicate`,
      ...withCookie(token),
    });
    expect(dup.statusCode).toBe(200);
    const copied = JSON.parse(dup.body).quiz;
    expect(copied.title).toBe("Renamed (copy)");
    expect(copied.status).toBe("DRAFT");
    expect(copied.questionCount).toBe(0);
  });

  it("deletes a quiz", async () => {
    const { token } = await registerUser(app);
    const quiz = await createQuiz(token);
    const resp = await app.inject({
      method: "DELETE",
      url: `/api/quizzes/${quiz.id}`,
      ...withCookie(token),
    });
    expect(resp.statusCode).toBe(200);
    const gone = await app.inject({
      method: "GET",
      url: `/api/quizzes/${quiz.id}`,
      ...withCookie(token),
    });
    expect(gone.statusCode).toBe(404);
  });
});