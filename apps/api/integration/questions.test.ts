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

const VALID_QUESTION = {
  text: "What is 2 + 2?",
  options: [
    { text: "3", isCorrect: false },
    { text: "4", isCorrect: true },
  ],
};

async function createQuiz(token: string) {
  const resp = await app.inject({
    method: "POST",
    url: "/api/quizzes",
    payload: { title: "Q Quiz" },
    ...withCookie(token),
  });
  return (JSON.parse(resp.body).quiz as { id: string }).id;
}

describe("question CRUD", () => {
  it("adds a question with options in order", async () => {
    const { token } = await registerUser(app);
    const quizId = await createQuiz(token);
    const resp = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions`,
      payload: VALID_QUESTION,
      ...withCookie(token),
    });
    expect(resp.statusCode).toBe(200);
    const question = JSON.parse(resp.body).question;
    expect(question.options).toHaveLength(2);
    expect(question.options[1]?.isCorrect).toBe(true);
  });

  it("rejects questions without exactly one correct option", async () => {
    const { token } = await registerUser(app);
    const quizId = await createQuiz(token);
    const bad = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions`,
      payload: { ...VALID_QUESTION, options: [{ text: "a", isCorrect: false }] },
      ...withCookie(token),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("updates a question (replaces options)", async () => {
    const { token } = await registerUser(app);
    const quizId = await createQuiz(token);
    const created = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions`,
      payload: VALID_QUESTION,
      ...withCookie(token),
    });
    const questionId = JSON.parse(created.body).question.id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/questions/${questionId}`,
      payload: {
        text: "Updated question",
        options: [
          { text: "x", isCorrect: true },
          { text: "y", isCorrect: false },
          { text: "z", isCorrect: false },
        ],
      },
      ...withCookie(token),
    });
    expect(updated.statusCode).toBe(200);
    const q = JSON.parse(updated.body).question;
    expect(q.text).toBe("Updated question");
    expect(q.options).toHaveLength(3);
    expect(q.options[0]?.isCorrect).toBe(true);
  });

  it("reorders questions", async () => {
    const { token } = await registerUser(app);
    const quizId = await createQuiz(token);
    const q1 = JSON.parse(
      (await app.inject({
        method: "POST",
        url: `/api/quizzes/${quizId}/questions`,
        payload: { ...VALID_QUESTION, text: "first" },
        ...withCookie(token),
      })).body,
    ).question;
    const q2 = JSON.parse(
      (await app.inject({
        method: "POST",
        url: `/api/quizzes/${quizId}/questions`,
        payload: { ...VALID_QUESTION, text: "second" },
        ...withCookie(token),
      })).body,
    ).question;

    const resp = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions/reorder`,
      payload: { questionIds: [q2.id, q1.id] },
      ...withCookie(token),
    });
    expect(resp.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/quizzes/${quizId}`,
      ...withCookie(token),
    });
    const questions = JSON.parse(detail.body).quiz.questions;
    expect(questions[0]?.id).toBe(q2.id);
    expect(questions[1]?.id).toBe(q1.id);
  });

  it("rejects an incomplete reorder set", async () => {
    const { token } = await registerUser(app);
    const quizId = await createQuiz(token);
    const q1 = JSON.parse(
      (await app.inject({
        method: "POST",
        url: `/api/quizzes/${quizId}/questions`,
        payload: { ...VALID_QUESTION, text: "a" },
        ...withCookie(token),
      })).body,
    ).question;
    const q2 = JSON.parse(
      (await app.inject({
        method: "POST",
        url: `/api/quizzes/${quizId}/questions`,
        payload: { ...VALID_QUESTION, text: "b" },
        ...withCookie(token),
      })).body,
    ).question;
    expect(q1.id).toBeTruthy();
    expect(q2.id).toBeTruthy();
    const resp = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions/reorder`,
      payload: { questionIds: [q1.id] },
      ...withCookie(token),
    });
    expect(resp.statusCode).toBe(400);
  });

  it("duplicates a quiz including its questions", async () => {
    const { token } = await registerUser(app);
    const quizId = await createQuiz(token);
    await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions`,
      payload: VALID_QUESTION,
      ...withCookie(token),
    });
    const dup = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/duplicate`,
      ...withCookie(token),
    });
    expect(JSON.parse(dup.body).quiz.questionCount).toBe(1);

    const detailResp = await app.inject({
      method: "GET",
      url: `/api/quizzes/${JSON.parse(dup.body).quiz.id}`,
      ...withCookie(token),
    });
    const detail = JSON.parse(detailResp.body).quiz;
    expect(detail.questions).toHaveLength(1);
    expect(detail.questions[0]?.options).toHaveLength(2);
    expect(detail.questions[0]?.options[1]?.isCorrect).toBe(true);
  });

  it("blocks cross-user question access", async () => {
    const { token } = await registerUser(app);
    const { token: otherToken } = await registerUser(app);
    const quizId = await createQuiz(token);
    const created = await app.inject({
      method: "POST",
      url: `/api/quizzes/${quizId}/questions`,
      payload: VALID_QUESTION,
      ...withCookie(token),
    });
    const questionId = JSON.parse(created.body).question.id;
    const resp = await app.inject({
      method: "PATCH",
      url: `/api/questions/${questionId}`,
      payload: VALID_QUESTION,
      ...withCookie(otherToken),
    });
    expect(resp.statusCode).toBe(403);
  });
});