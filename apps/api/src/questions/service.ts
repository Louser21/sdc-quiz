import type { QuestionUpsertDto, QuestionViewDto } from "@quiz/shared";
import { prisma } from "../db/client.js";
import { AppError, isForeignKeyViolation } from "../errors/index.js";

async function getQuestionOwned(questionId: string, userId: string) {
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    include: { quiz: { select: { creatorId: true } } },
  });
  if (!question) throw new AppError("NOT_FOUND", "Question not found", 404);
  if (question.quiz.creatorId !== userId) {
    throw new AppError("FORBIDDEN", "You do not own this question", 403);
  }
  return question;
}

async function getQuizOwned(quizId: string, userId: string) {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz) throw new AppError("NOT_FOUND", "Quiz not found", 404);
  if (quiz.creatorId !== userId) throw new AppError("FORBIDDEN", "You do not own this quiz", 403);
  return quiz;
}

function toView(q: {
  id: string;
  text: string;
  position: number;
  timeLimit: number;
  options: { id: string; text: string; isCorrect: boolean }[];
}): QuestionViewDto {
  return {
    id: q.id,
    text: q.text,
    position: q.position,
    timeLimit: q.timeLimit,
    options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
  };
}

export async function addQuestion(
  userId: string,
  quizId: string,
  dto: QuestionUpsertDto,
): Promise<QuestionViewDto> {
  const quiz = await getQuizOwned(quizId, userId);
  const last = await prisma.question.aggregate({
    where: { quizId: quiz.id },
    _max: { position: true },
  });
  const position = (last._max.position ?? -1) + 1;
  const created = await prisma.question.create({
    data: {
      quizId: quiz.id,
      text: dto.text,
      position,
      timeLimit: dto.timeLimit,
      options: {
        create: dto.options.map((o, i) => ({ text: o.text, position: i, isCorrect: o.isCorrect })),
      },
    },
    include: { options: { orderBy: { position: "asc" } } },
  });
  return toView(created);
}

export async function updateQuestion(
  userId: string,
  questionId: string,
  dto: QuestionUpsertDto,
): Promise<QuestionViewDto> {
  const question = await getQuestionOwned(questionId, userId);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.question.update({
      where: { id: question.id },
      data: { text: dto.text, timeLimit: dto.timeLimit },
    });
    await tx.option.deleteMany({ where: { questionId: question.id } });
    await tx.option.createMany({
      data: dto.options.map((o, i) => ({
        questionId: question.id,
        text: o.text,
        position: i,
        isCorrect: o.isCorrect,
      })),
    });
    return tx.question.findUniqueOrThrow({
      where: { id: question.id },
      include: { options: { orderBy: { position: "asc" } } },
    });
  });
  return toView(updated);
}

export async function deleteQuestion(userId: string, questionId: string): Promise<void> {
  const question = await getQuestionOwned(questionId, userId);
  try {
    await prisma.question.delete({ where: { id: question.id } });
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      throw new AppError(
        "CONFLICT",
        "This question has been used in a played game and cannot be deleted.",
        409,
      );
    }
    throw e;
  }
  // Close position gaps so ordering stays contiguous.
  const siblings = await prisma.question.findMany({
    where: { quizId: question.quizId },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  await prisma.$transaction(
    siblings.map((s, i) =>
      prisma.question.updateMany({ where: { id: s.id }, data: { position: i } }),
    ),
  );
}

export async function reorderQuestions(
  userId: string,
  quizId: string,
  questionIds: string[],
): Promise<void> {
  const quiz = await getQuizOwned(quizId, userId);
  const existing = await prisma.question.findMany({
    where: { quizId: quiz.id },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((q) => q.id));
  if (
    questionIds.length !== existing.length ||
    questionIds.some((id) => !existingIds.has(id))
  ) {
    throw new AppError("VALIDATION_ERROR", "Order must include every question exactly once", 400);
  }
  await prisma.$transaction(
    questionIds.map((id, i) =>
      prisma.question.updateMany({ where: { id, quizId: quiz.id }, data: { position: i } }),
    ),
  );
}