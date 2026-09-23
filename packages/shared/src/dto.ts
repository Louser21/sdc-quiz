import { z } from "zod";
import { ID_SCHEMA } from "./constants.js";

// ---------------------------------------------------------------------------
// Auth DTOs
// ---------------------------------------------------------------------------

export const RegisterDto = z.object({
  email: z.string().trim().toLowerCase().email("Provide a valid email"),
  name: z.string().trim().min(1).max(60, "Name too long"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});
export type RegisterDto = z.infer<typeof RegisterDto>;

export const LoginDto = z.object({
  email: z.string().trim().toLowerCase().email("Provide a valid email"),
  password: z.string().min(1).max(128),
});
export type LoginDto = z.infer<typeof LoginDto>;

export const UserDto = z.object({
  id: ID_SCHEMA,
  email: z.string().email(),
  name: z.string(),
  role: z.enum(["HOST", "ADMIN"]),
});
export type UserDto = z.infer<typeof UserDto>;

// ---------------------------------------------------------------------------
// Quiz DTOs
// ---------------------------------------------------------------------------

export const QUIZ_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export const QuizStatusSchema = z.enum(QUIZ_STATUSES);
export type QuizStatus = (typeof QUIZ_STATUSES)[number];

export const QuizCreateDto = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  description: z.string().trim().max(2000).default(""),
});
export type QuizCreateDto = z.infer<typeof QuizCreateDto>;

export const QuizUpdateDto = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    status: QuizStatusSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type QuizUpdateDto = z.infer<typeof QuizUpdateDto>;

export const QuizSummaryDto = z.object({
  id: ID_SCHEMA,
  title: z.string(),
  description: z.string(),
  status: QuizStatusSchema,
  questionCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type QuizSummaryDto = z.infer<typeof QuizSummaryDto>;

// ---------------------------------------------------------------------------
// Question DTOs
// ---------------------------------------------------------------------------

export const OptionUpsertDto = z.object({
  text: z.string().trim().min(1, "Option text is required").max(300),
  isCorrect: z.boolean().default(false),
});
export type OptionUpsertDto = z.infer<typeof OptionUpsertDto>;

export const QuestionUpsertDto = z
  .object({
    text: z.string().trim().min(1, "Question text is required").max(2000),
    timeLimit: z.coerce.number().int().min(3).max(600).default(20),
    options: z.array(OptionUpsertDto).min(2, "At least 2 options required").max(8),
  })
  .refine((q) => q.options.filter((o) => o.isCorrect).length === 1, "Exactly one correct option required");
export type QuestionUpsertDto = z.infer<typeof QuestionUpsertDto>;

export const ReorderQuestionsDto = z.object({
  questionIds: z.array(ID_SCHEMA).min(1),
});
export type ReorderQuestionsDto = z.infer<typeof ReorderQuestionsDto>;

export const OptionViewDto = z.object({
  id: ID_SCHEMA,
  text: z.string(),
  isCorrect: z.boolean(),
});
export type OptionViewDto = z.infer<typeof OptionViewDto>;

export const QuestionViewDto = z.object({
  id: ID_SCHEMA,
  text: z.string(),
  position: z.number().int(),
  timeLimit: z.number().int(),
  options: z.array(OptionViewDto),
});
export type QuestionViewDto = z.infer<typeof QuestionViewDto>;

export const QuizDetailDto = z.object({
  id: ID_SCHEMA,
  title: z.string(),
  description: z.string(),
  status: QuizStatusSchema,
  questions: z.array(QuestionViewDto),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type QuizDetailDto = z.infer<typeof QuizDetailDto>;