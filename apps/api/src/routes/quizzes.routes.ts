import type { FastifyInstance } from "fastify";
import { QuizCreateDto, QuizUpdateDto, ReorderQuestionsDto, QuestionUpsertDto } from "@quiz/shared";
import { requireAuth } from "../auth/plugin.js";
import { parseWith } from "../errors/index.js";
import * as quizzes from "../quizzes/service.js";
import * as questions from "../questions/service.js";

export const quizRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/quizzes", async (req) => {
    const user = requireAuth(req);
    return { quizzes: await quizzes.listQuizzes(user.id) };
  });

  app.post("/quizzes", async (req, reply) => {
    const user = requireAuth(req);
    const body = parseWith(QuizCreateDto, req.body);
    return reply.status(201).send({ quiz: await quizzes.createQuiz(user.id, body) });
  });

  app.get("/quizzes/:id", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    return { quiz: await quizzes.getQuizDetail(user.id, id) };
  });

  app.patch("/quizzes/:id", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const body = parseWith(QuizUpdateDto, req.body);
    return { quiz: await quizzes.updateQuiz(user.id, id, body) };
  });

  app.delete("/quizzes/:id", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    await quizzes.deleteQuiz(user.id, id);
    return { ok: true };
  });

  app.post("/quizzes/:id/duplicate", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    return { quiz: await quizzes.duplicateQuiz(user.id, id) };
  });

  app.post("/quizzes/:id/publish", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    return { quiz: await quizzes.setQuizStatus(user.id, id, "PUBLISHED") };
  });

  app.post("/quizzes/:id/unpublish", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    return { quiz: await quizzes.setQuizStatus(user.id, id, "DRAFT") };
  });

  // --- Questions -----------------------------------------------------------

  app.post("/quizzes/:id/questions", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const body = parseWith(QuestionUpsertDto, req.body);
    return { question: await questions.addQuestion(user.id, id, body) };
  });

  app.post("/quizzes/:id/questions/reorder", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const body = parseWith(ReorderQuestionsDto, req.body);
    await questions.reorderQuestions(user.id, id, body.questionIds);
    return { ok: true };
  });

  app.patch("/questions/:id", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const body = parseWith(QuestionUpsertDto, req.body);
    return { question: await questions.updateQuestion(user.id, id, body) };
  });

  app.delete("/questions/:id", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    await questions.deleteQuestion(user.id, id);
    return { ok: true };
  });
};