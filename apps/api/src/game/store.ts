import type { GamePhase, GameSessionStatus, LeaderboardEntry } from "@quiz/shared";
import { GAME_TRANSITIONS } from "@quiz/shared";
import { redis } from "../redis/client.js";
import { AppError, errors } from "../errors/index.js";
import { logGame } from "../logging/logger.js";
import { getLeaderboard, setScore } from "../leaderboard/index.js";

// ---------------------------------------------------------------------------
// Key layout
// ---------------------------------------------------------------------------

const stateKey = (id: string) => `game:${id}`;
const playersKey = (id: string) => `game:${id}:players`;
const answersKey = (id: string) => `game:${id}:answers`;
const markedKey = (id: string) => `game:${id}:marked`;
const questionsKey = (id: string) => `game:${id}:questions`;

const GAME_KEEPALIVE_SECONDS = 24 * 60 * 60;

export interface PlayerRecord {
  nickname: string;
  score: number;
  connected: boolean;
  submitted: boolean;
  submittedAt: number | null;
  joinedAt: number;
}

export interface QuestionSnapshotOption {
  id: string;
  text: string;
}

export interface QuestionSnapshot {
  id: string;
  text: string;
  options: QuestionSnapshotOption[];
}

export interface QuestionsSnapshot {
  list: QuestionSnapshot[];
  correct: Record<string, string>;
}

export interface GameStateRow {
  gameId: string;
  joinCode: string;
  quizId: string;
  quizTitle: string;
  hostUserId: string;
  phase: GamePhase | string;
  hostConnected: boolean;
  timeLimitSeconds: number;
  paperStartedAt: number | null;
  deadline: number | null;
  submittedCount: number;
}

export const PHASE_DEFAULT = "LOBBY";

// ---------------------------------------------------------------------------
// Lua scripts (atomic state transitions). Loaded once per process.
// ---------------------------------------------------------------------------

const LUA = {
  startPaper: `
local state = KEYS[1]
local phase = redis.call("HGET", state, "phase")
if phase ~= "LOBBY" then
  return redis.error_reply("INVALID_TRANSITION")
end
redis.call("HSET", state,
  "phase", "ACTIVE",
  "paperStartedAt", ARGV[1],
  "deadline", ARGV[2])
return redis.call("HGETALL", state)`,
  setAnswer: `
local state = KEYS[1]
local answers = KEYS[2]
local players = KEYS[3]
local phase = redis.call("HGET", state, "phase")
if phase ~= "ACTIVE" then
  return redis.error_reply("PAPER_NOT_ACTIVE")
end
local deadline = tonumber(redis.call("HGET", state, "deadline"))
if tonumber(ARGV[4]) >= deadline then
  return redis.error_reply("PAPER_ENDED")
end
local rec = redis.call("HGET", players, ARGV[2])
if not rec then
  return redis.error_reply("PLAYER_NOT_FOUND")
end
local obj = cjson.decode(rec)
if obj.submitted then
  return redis.error_reply("PLAYER_ALREADY_SUBMITTED")
end
redis.call("HSET", answers, ARGV[2] .. ":" .. ARGV[3], ARGV[1])
return { "OK" }`,
  markReview: `
local state = KEYS[1]
local marked = KEYS[2]
local players = KEYS[3]
local phase = redis.call("HGET", state, "phase")
if phase ~= "ACTIVE" then
  return redis.error_reply("PAPER_NOT_ACTIVE")
end
local deadline = tonumber(redis.call("HGET", state, "deadline"))
if tonumber(ARGV[4]) >= deadline then
  return redis.error_reply("PAPER_ENDED")
end
local rec = redis.call("HGET", players, ARGV[2])
if not rec then
  return redis.error_reply("PLAYER_NOT_FOUND")
end
local obj = cjson.decode(rec)
if obj.submitted then
  return redis.error_reply("PLAYER_ALREADY_SUBMITTED")
end
local field = ARGV[2] .. ":" .. ARGV[3]
if ARGV[1] == "1" then
  redis.call("HSET", marked, field, "1")
else
  redis.call("HDEL", marked, field)
end
return { "OK" }`,
  submitPaper: `
local state = KEYS[1]
local players = KEYS[2]
local phase = redis.call("HGET", state, "phase")
if phase ~= "ACTIVE" then
  return redis.error_reply("PAPER_NOT_ACTIVE")
end
local deadline = tonumber(redis.call("HGET", state, "deadline"))
if tonumber(ARGV[2]) >= deadline then
  return redis.error_reply("PAPER_ENDED")
end
local rec = redis.call("HGET", players, ARGV[1])
if not rec then
  return redis.error_reply("PLAYER_NOT_FOUND")
end
local obj = cjson.decode(rec)
if obj.submitted then
  return { "ALREADY_SUBMITTED" }
end
obj.submitted = true
obj.submittedAt = tonumber(ARGV[2])
redis.call("HSET", players, ARGV[1], cjson.encode(obj))
redis.call("HINCRBY", state, "submittedCount", 1)
return { "OK" }`,
  autoSubmitRemaining: `
local state = KEYS[1]
local players = KEYS[2]
local now = tonumber(ARGV[1])
local count = 0
local flat = redis.call("HGETALL", players)
for i = 1, #flat, 2 do
  local pid = flat[i]
  local rec = redis.call("HGET", players, pid)
  if rec then
    local obj = cjson.decode(rec)
    if not obj.submitted then
      obj.submitted = true
      obj.submittedAt = now
      redis.call("HSET", players, pid, cjson.encode(obj))
      count = count + 1
    end
  end
end
if count > 0 then
  redis.call("HSET", state, "submittedCount", count)
end
return { tostring(count) }`,
  finishGame: `
local state = KEYS[1]
local players = KEYS[2]
local phase = redis.call("HGET", state, "phase")
if phase == "FINISHED" then
  return { "FINISHED" }
end
if phase ~= "ACTIVE" and phase ~= "LOBBY" then
  return redis.error_reply("INVALID_TRANSITION")
end
redis.call("HSET", state, "phase", "FINISHED")
local playersCount = redis.call("HLEN", players)
return { "FINISHED", tostring(playersCount or 0) }`,
};

interface LuaCmd {
  startPaper: (...args: (string | number)[]) => Promise<string[]>;
  setAnswer: (...args: (string | number)[]) => Promise<string[]>;
  markReview: (...args: (string | number)[]) => Promise<string[]>;
  submitPaper: (...args: (string | number)[]) => Promise<string[]>;
  autoSubmitRemaining: (...args: (string | number)[]) => Promise<string[]>;
  finishGame: (...args: (string | number)[]) => Promise<string[]>;
}

let scriptsLoaded = false;
function ensureScripts(): void {
  if (scriptsLoaded) return;
  Object.entries(LUA).forEach(([name, lua]) => {
    redis.defineCommand(name, { numberOfKeys: luaKeys(name), lua });
  });
  scriptsLoaded = true;
}

// Register Lua commands once per process, at module load, so they exist even
// when the first operation in this process is not createGame (e.g. boot restore).
ensureScripts();

function luaKeys(name: string): number {
  switch (name) {
    case "setAnswer":
    case "markReview":
      return 3;
    case "submitPaper":
    case "autoSubmitRemaining":
    case "finishGame":
      return 2;
    default:
      return 1;
  }
}

function parseLuaReplyError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("INVALID_TRANSITION")) return errors.invalidTransition();
  if (message.includes("PAPER_NOT_ACTIVE")) return errors.paperNotActive();
  if (message.includes("PAPER_ENDED")) return errors.paperEnded();
  if (message.includes("PLAYER_ALREADY_SUBMITTED")) return errors.alreadySubmitted();
  if (message.includes("PLAYER_NOT_FOUND")) return errors.invalidSession("Player session no longer valid for this game");
  if (err instanceof Error) {
    return new AppError("INTERNAL_ERROR", message, 500, true);
  }
  return errors.internal();
}

function rowsFromFlat(flat: string[]): Record<string, string> {
  const row: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) {
    const key = flat[i];
    const value = flat[i + 1];
    if (key !== undefined && value !== undefined) row[key] = value;
  }
  return row;
}

function parseState(row: Record<string, string>): GameStateRow {
  return {
    gameId: row.gameId ?? "",
    joinCode: row.joinCode ?? "",
    quizId: row.quizId ?? "",
    quizTitle: row.quizTitle ?? "",
    hostUserId: row.hostUserId ?? "",
    phase: row.phase ?? PHASE_DEFAULT,
    hostConnected: row.hostConnected === "1",
    timeLimitSeconds: Number(row.timeLimitSeconds ?? 0),
    paperStartedAt: row.paperStartedAt ? Number(row.paperStartedAt) : null,
    deadline: row.deadline ? Number(row.deadline) : null,
    submittedCount: Number(row.submittedCount ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Game lifecycle (Phase 2)
// ---------------------------------------------------------------------------

export async function createGame(
  meta: {
    gameId: string;
    joinCode: string;
    quizId: string;
    quizTitle: string;
    hostUserId: string;
    timeLimitSeconds: number;
  },
  questions: QuestionsSnapshot,
): Promise<void> {
  ensureScripts();
  const pipe = redis.multi();
  pipe.del(playersKey(meta.gameId), answersKey(meta.gameId), markedKey(meta.gameId));
  pipe.hset(stateKey(meta.gameId), {
    gameId: meta.gameId,
    joinCode: meta.joinCode,
    quizId: meta.quizId,
    quizTitle: meta.quizTitle,
    hostUserId: meta.hostUserId,
    phase: PHASE_DEFAULT,
    hostConnected: "0",
    timeLimitSeconds: String(meta.timeLimitSeconds),
    paperStartedAt: "",
    deadline: "",
    submittedCount: "0",
  });
  pipe.set(questionsKey(meta.gameId), JSON.stringify(questions));
  pipe.expire(stateKey(meta.gameId), GAME_KEEPALIVE_SECONDS);
  pipe.expire(questionsKey(meta.gameId), GAME_KEEPALIVE_SECONDS);
  await pipe.exec();
  logGame("GAME_CREATED", { gameId: meta.gameId, quizId: meta.quizId, joinCode: meta.joinCode });
}

export async function deleteGame(gameId: string): Promise<void> {
  await redis.del(
    stateKey(gameId),
    playersKey(gameId),
    answersKey(gameId),
    markedKey(gameId),
    questionsKey(gameId),
  );
  await redis.del(`leaderboard:${gameId}`);
}

export async function touchGame(gameId: string): Promise<void> {
  await redis.expire(stateKey(gameId), GAME_KEEPALIVE_SECONDS);
}

export async function getState(gameId: string): Promise<GameStateRow | null> {
  const row = await redis.hgetall(stateKey(gameId));
  if (!row || Object.keys(row).length === 0) return null;
  return parseState(row);
}

/** List live game ids from Redis keys matching `game:{id}` state hashes. */
export async function listLiveGameIds(): Promise<string[]> {
  const keys = await redis.keys("game:*");
  const ids: string[] = [];
  for (const key of keys) {
    const parts = key.split(":");
    // state keys are exactly game:{id}; players/answers/marked/questions have extra segments
    if (parts.length === 2 && parts[0] === "game" && parts[1]) {
      ids.push(parts[1]);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Phase transitions — atomic in Lua (Phase 3)
// ---------------------------------------------------------------------------

export async function startPaper(gameId: string, now: number, deadline: number): Promise<GameStateRow> {
  ensureScripts();
  try {
    const flat = (await (redis as unknown as LuaCmd).startPaper(
      stateKey(gameId),
      now,
      deadline,
    )) as string[];
    await touchGame(gameId);
    logGame("PAPER_STARTED", { gameId, deadline });
    return parseState(rowsFromFlat(flat as string[]));
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

export async function setAnswer(
  gameId: string,
  playerId: string,
  questionId: string,
  optionId: string,
  now: number,
): Promise<void> {
  try {
    await (redis as unknown as LuaCmd).setAnswer(
      stateKey(gameId),
      answersKey(gameId),
      playersKey(gameId),
      optionId,
      playerId,
      questionId,
      now,
    );
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

export async function setMarked(
  gameId: string,
  playerId: string,
  questionId: string,
  marked: boolean,
  now: number,
): Promise<void> {
  try {
    await (redis as unknown as LuaCmd).markReview(
      stateKey(gameId),
      markedKey(gameId),
      playersKey(gameId),
      marked ? "1" : "",
      playerId,
      questionId,
      now,
    );
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

export interface SubmitPaperResult {
  alreadySubmitted: boolean;
  submittedAt: number;
}

export async function submitPaper(gameId: string, playerId: string, now: number): Promise<SubmitPaperResult> {
  try {
    const reply = (await (redis as unknown as LuaCmd).submitPaper(
      stateKey(gameId),
      playersKey(gameId),
      playerId,
      now,
    )) as string[];
    return {
      alreadySubmitted: (reply[0] ?? "") === "ALREADY_SUBMITTED",
      submittedAt: now,
    };
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

/** Mark every not-yet-submitted player as submitted (deadline / host end). Returns how many were auto-submitted. */
export async function autoSubmitRemaining(gameId: string, now: number): Promise<number> {
  try {
    const reply = (await (redis as unknown as LuaCmd).autoSubmitRemaining(
      stateKey(gameId),
      playersKey(gameId),
      now,
    )) as string[];
    return Number(reply[0] ?? 0);
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

export async function finishGame(gameId: string): Promise<{ playerCount: number }> {
  try {
    const reply = (await (redis as unknown as LuaCmd).finishGame(
      stateKey(gameId),
      playersKey(gameId),
    )) as string[];
    await touchGame(gameId);
    return { playerCount: Number(reply[1] ?? 0) };
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

/** Guard before any phase transition: LOBBY -> ACTIVE -> FINISHED only. */
export function assertTransition(from: GamePhase, to: GamePhase): void {
  const allowed = GAME_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw errors.invalidTransition(`${from} -> ${to} is not a valid transition`);
  }
}

// ---------------------------------------------------------------------------
// Players + presence
// ---------------------------------------------------------------------------

export async function getPlayers(gameId: string): Promise<Record<string, PlayerRecord>> {
  const flat = await redis.hgetall(playersKey(gameId));
  const players: Record<string, PlayerRecord> = {};
  for (const [playerId, json] of Object.entries(flat)) {
    try {
      players[playerId] = JSON.parse(json) as PlayerRecord;
    } catch {
      // Skip corrupt entries; restore repairs from PG if needed.
    }
  }
  return players;
}

export async function getPlayer(gameId: string, playerId: string): Promise<PlayerRecord | null> {
  const json = await redis.hget(playersKey(gameId), playerId);
  if (!json) return null;
  try {
    return JSON.parse(json) as PlayerRecord;
  } catch {
    return null;
  }
}

export async function upsertPlayer(
  gameId: string,
  playerId: string,
  record: PlayerRecord,
): Promise<void> {
  await redis.hset(playersKey(gameId), playerId, JSON.stringify(record));
  await redis.expire(playersKey(gameId), GAME_KEEPALIVE_SECONDS);
  await setScore(gameId, playerId, record.score);
}

export async function setPlayerConnected(
  gameId: string,
  playerId: string,
  connected: boolean,
): Promise<void> {
  const record = await getPlayer(gameId, playerId);
  if (!record) return;
  record.connected = connected;
  await redis.hset(playersKey(gameId), playerId, JSON.stringify(record));
  await redis.expire(playersKey(gameId), GAME_KEEPALIVE_SECONDS);
}

export async function setHostConnected(gameId: string, connected: boolean): Promise<void> {
  await redis.hset(stateKey(gameId), "hostConnected", connected ? "1" : "0");
}

export async function setPlayerScore(gameId: string, playerId: string, score: number): Promise<void> {
  const record = await getPlayer(gameId, playerId);
  if (!record) return;
  record.score = score;
  await redis.hset(playersKey(gameId), playerId, JSON.stringify(record));
  await setScore(gameId, playerId, score);
}

export async function removePlayerFromGame(gameId: string, playerId: string): Promise<void> {
  await redis.hdel(playersKey(gameId), playerId);
  await redis.zrem(`leaderboard:${gameId}`, playerId);
}

// ---------------------------------------------------------------------------
// Selections (the paper state) + mark-for-review
// ---------------------------------------------------------------------------

/** Latest selection per question for a player, keyed by questionId. */
export async function getSelections(
  gameId: string,
  playerId: string,
): Promise<Record<string, string>> {
  const flat = await redis.hgetall(answersKey(gameId));
  const prefix = `${playerId}:`;
  const selections: Record<string, string> = {};
  for (const [field, optionId] of Object.entries(flat)) {
    if (!field.startsWith(prefix)) continue;
    const questionId = field.slice(prefix.length);
    if (!questionId) continue;
    selections[questionId] = optionId;
  }
  return selections;
}

export async function getMarked(gameId: string, playerId: string): Promise<Record<string, boolean>> {
  const flat = await redis.hgetall(markedKey(gameId));
  const prefix = `${playerId}:`;
  const marked: Record<string, boolean> = {};
  for (const [field] of Object.entries(flat)) {
    if (!field.startsWith(prefix)) continue;
    const questionId = field.slice(prefix.length);
    if (!questionId) continue;
    marked[questionId] = true;
  }
  return marked;
}

// ---------------------------------------------------------------------------
// Questions snapshot (server-private: correct map never leaves this module)
// ---------------------------------------------------------------------------

export async function getQuestions(gameId: string): Promise<QuestionsSnapshot> {
  const raw = await redis.get(questionsKey(gameId));
  if (!raw) throw errors.notFound("Game state not found");
  try {
    return JSON.parse(raw) as QuestionsSnapshot;
  } catch {
    throw errors.internal("Corrupt questions snapshot");
  }
}

/** Ordered question list by position (snapshot ordering matches quiz). */
export async function getOrderedQuestions(gameId: string): Promise<QuestionSnapshot[]> {
  const snap = await getQuestions(gameId);
  return snap.list;
}

export function toLeaderboardEntries(
  players: Record<string, PlayerRecord>,
): LeaderboardEntry[] {
  return Object.entries(players)
    .filter(([, record]) => record.submitted)
    .map(([playerId, record]) => ({ playerId, nickname: record.nickname, score: record.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}

export { getLeaderboard };

/** Used by routes before returning summaries (kept here to centralize key access). */
export async function playerCount(gameId: string): Promise<number> {
  return redis.hlen(playersKey(gameId));
}

export async function getSessionStatus(gameId: string): Promise<GameSessionStatus> {
  return (await getState(gameId))?.phase === "FINISHED" ? "FINISHED" : "ACTIVE";
}