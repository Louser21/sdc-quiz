import type { QuizCreateDto, QuizDetailDto, QuizSummaryDto, QuizUpdateDto } from "@quiz/shared";
import { prisma } from "../db/client.js";
import { AppError, isForeignKeyViolation } from "../errors/index.js";

function toSummary(
  q: {
    id: string;
    title: string;
    description: string;
    status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
    timeLimitSeconds: number;
    _count?: { questions: number };
    createdAt: Date;
    updatedAt: Date;
  },
  questionCount?: number,
): QuizSummaryDto {
  return {
    id: q.id,
    title: q.title,
    description: q.description,
    status: q.status,
    timeLimitSeconds: q.timeLimitSeconds,
    questionCount: questionCount ?? q._count?.questions ?? 0,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

async function getOwned(quizId: string, userId: string) {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz) throw new AppError("NOT_FOUND", "Quiz not found", 404);
  if (quiz.creatorId !== userId) {
    throw new AppError("FORBIDDEN", "You do not own this quiz", 403);
  }
  return quiz;
}

export async function listQuizzes(userId: string): Promise<QuizSummaryDto[]> {
  const quizzes = await prisma.quiz.findMany({
    where: { creatorId: userId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { questions: true } } },
  });
  return quizzes.map((q) => ({
    id: q.id,
    title: q.title,
    description: q.description,
    status: q.status,
    timeLimitSeconds: q.timeLimitSeconds,
    questionCount: q._count.questions,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  }));
}

export async function createQuiz(userId: string, dto: QuizCreateDto): Promise<QuizSummaryDto> {
  const quiz = await prisma.quiz.create({
    data: {
      title: dto.title,
      description: dto.description,
      timeLimitSeconds: dto.timeLimitSeconds,
      creatorId: userId,
    },
  });
  return toSummary(quiz, 0);
}

export async function getQuizDetail(userId: string, quizId: string): Promise<QuizDetailDto> {
  const quiz = await getOwned(quizId, userId);
  const questions = await prisma.question.findMany({
    where: { quizId: quiz.id },
    orderBy: { position: "asc" },
    include: { options: { orderBy: { position: "asc" } } },
  });
  return {
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    status: quiz.status,
    timeLimitSeconds: quiz.timeLimitSeconds,
    createdAt: quiz.createdAt.toISOString(),
    updatedAt: quiz.updatedAt.toISOString(),
    questions: questions.map((q) => ({
      id: q.id,
      text: q.text,
      position: q.position,
      options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
    })),
  };
}

export async function updateQuiz(
  userId: string,
  quizId: string,
  dto: QuizUpdateDto,
): Promise<QuizSummaryDto> {
  const quiz = await getOwned(quizId, userId);
  const updated = await prisma.quiz.update({
    where: { id: quiz.id },
    data: {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.timeLimitSeconds !== undefined ? { timeLimitSeconds: dto.timeLimitSeconds } : {}),
    },
    include: { _count: { select: { questions: true } } },
  });
  return toSummary(updated);
}

export async function deleteQuiz(userId: string, quizId: string): Promise<void> {
  const quiz = await getOwned(quizId, userId);
  try {
    await prisma.quiz.delete({ where: { id: quiz.id } });
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      throw new AppError(
        "CONFLICT",
        "This quiz has game history and cannot be deleted. Archive it instead.",
        409,
      );
    }
    throw e;
  }
}

export async function setQuizStatus(
  userId: string,
  quizId: string,
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED",
): Promise<QuizSummaryDto> {
  return updateQuiz(userId, quizId, { status });
}

/** Deep-copy a quiz incl. all questions and options. */
export async function duplicateQuiz(userId: string, quizId: string): Promise<QuizSummaryDto> {
  const source = await getOwned(quizId, userId);
  const questions = await prisma.question.findMany({
    where: { quizId: source.id },
    orderBy: { position: "asc" },
    include: { options: { orderBy: { position: "asc" } } },
  });

  const copy = await prisma.$transaction(async (tx) => {
    const newQuiz = await tx.quiz.create({
      data: {
        title: `${source.title} (copy)`,
        description: source.description,
        status: "DRAFT",
        timeLimitSeconds: source.timeLimitSeconds,
        creatorId: userId,
      },
    });
    for (const q of questions) {
      await tx.question.create({
        data: {
          quizId: newQuiz.id,
          text: q.text,
          position: q.position,
          options: {
            create: q.options.map((o) => ({
              text: o.text,
              position: o.position,
              isCorrect: o.isCorrect,
            })),
          },
        },
      });
    }
    return newQuiz;
  });

  return toSummary(copy, questions.length);
}