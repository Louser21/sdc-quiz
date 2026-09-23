/**
 * Redis key layout. ALL live game state lives under these keys so a backend
 * restart can rebuild and continue a game without losing state.
 */
export const keys = {
  /** Hash: { quizId, joinCode, state, hostId, hostPresent, questionIndex, totalQuestions, quizTitle } */
  game: (gameId: string) => `game:${gameId}`,

  /** joinCode -> gameId (fast join lookup, avoids a DB query on the hot path) */
  gameByCode: (joinCode: string) => `code:${joinCode}`,

  /** Set of connected player session ids for a game */
  gamePresence: (gameId: string) => `game:presence:${gameId}`,

  /** Hash: playerId -> sessionId */
  gamePlayers: (gameId: string) => `game:players:${gameId}`,

  /** Hash: { gameId, playerId, nickname, connectedAt } keyed by session id */
  player: (sessionId: string) => `player:${sessionId}`,

  /** Sorted set: score -> playerId (live leaderboard) */
  leaderboard: (gameId: string) => `leaderboard:${gameId}`,

  /** Hash: playerId -> JSON { optionId, correct, points, submittedAt, questionEndsAt } */
  answers: (gameId: string, questionId: string) => `answers:${gameId}:${questionId}`,

  /** String epoch-ms deadline for the active question */
  deadline: (gameId: string) => `deadline:${gameId}`,

  /** JSON cache of the active question incl. correct option (revoked from players) */
  question: (gameId: string) => `question:${gameId}`,

  /** Host command idempotency: runId -> 1 */
  hostCommand: (gameId: string, command: string, runId: string) =>
    `hostcmd:${gameId}:${command}:${runId}`,

  /** Sliding-window rate limit buckets */
  rateLimit: (scope: string, key: string) => `rl:${scope}:${key}`,
} as const;