import { getConfig } from "../config.js";

export interface QuestionTiming {
  timeLimit: number;
  startedAt: number;
  endsAt: number;
  /** server clock at the moment the answer was received */
  now: number;
}

/**
 * Server-authoritative scoring. The client never supplies points.
 *
 * points = round(BASE * (MIN_FRACTION + (1 - MIN_FRACTION) * remainingFraction))
 *
 * - Correct answers only.
 * - Faster correct answers earn proportionally more within [MIN_FRACTION, 1] of BASE.
 * - Wrong answers always earn 0.
 */
export function calculateScore(timing: QuestionTiming, correct: boolean): number {
  if (!correct) return 0;
  const total = timing.endsAt - timing.startedAt;
  if (total <= 0) return 0;
  const remaining = Math.max(0, timing.endsAt - timing.now);
  const fraction = Math.min(1, remaining / total);
  const config = getConfig();
  const points =
    config.SCORE_BASE * (config.SCORE_MIN_FRACTION + (1 - config.SCORE_MIN_FRACTION) * fraction);
  return Math.round(points);
}

/**
 * Deadline boundary: an answer is only accepted while `serverNow < questionEndsAt`.
 * At exactly `questionEndsAt` the question is over — the last instant belongs to the deadline.
 */
export function isAnswerOnTime(serverNow: number, questionEndsAt: number): boolean {
  return serverNow < questionEndsAt;
}