import { getConfig } from "../config.js";

/**
 * Server-authoritative scoring (CBT fixed-points model). The client never
 * supplies points, and correctness is resolved server-side at submit time.
 *
 *   points = correct ? SCORE_BASE : 0
 *
 * There is intentionally no speed component — a participant's whole paper is
 * submitted at once, so fixed value per correct answer is the fair model.
 */
export function scoreForCorrectness(correct: boolean): number {
  return correct ? getConfig().SCORE_BASE : 0;
}

/**
 * Deadline boundary: options are only accepted while `serverNow < deadline`.
 * At exactly `deadline` the paper is over and every unsubmitted paper is
 * auto-submitted — the last instant belongs to the deadline.
 */
export function isWithinPaperDeadline(serverNow: number, deadline: number): boolean {
  return serverNow < deadline;
}