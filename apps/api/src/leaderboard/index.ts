import type { LeaderboardEntry } from "@quiz/shared";
import { redis } from "../redis/client.js";

export function leaderboardKey(gameId: string): string {
  return `leaderboard:${gameId}`;
}

/** Set a player's absolute score (used on restore / finalization). */
export async function setScore(gameId: string, playerId: string, score: number): Promise<void> {
  await redis.zadd(leaderboardKey(gameId), score, playerId);
}

/** Increment a player's score after an accepted answer (called exactly once per accept). */
export async function bumpScore(
  gameId: string,
  playerId: string,
  delta: number,
): Promise<number> {
  const score = await redis.zincrby(leaderboardKey(gameId), delta, playerId);
  return Number(score);
}

export async function removePlayer(gameId: string, playerId: string): Promise<void> {
  await redis.zrem(leaderboardKey(gameId), playerId);
}

/**
 * Live leaderboard: top entries by score descending from the Redis sorted set.
 * Never queries PostgreSQL per answer (spec §18).
 * `nicknames` maps playerId -> nickname for display.
 */
export async function getLeaderboard(
  gameId: string,
  nicknames: Map<string, string>,
  limit = 50,
): Promise<LeaderboardEntry[]> {
  const flat = await redis.zrevrange(leaderboardKey(gameId), 0, limit - 1, "WITHSCORES");
  const entries: LeaderboardEntry[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const playerId = flat[i];
    const score = Number(flat[i + 1]);
    if (playerId === undefined || Number.isNaN(score)) continue;
    const nickname = nicknames.get(playerId);
    if (nickname === undefined) continue;
    entries.push({ playerId, nickname, score });
  }
  return entries;
}