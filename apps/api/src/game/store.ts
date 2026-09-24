import type { GamePhase, GameSessionStatus, LeaderboardEntry } from "@quiz/shared";
import { redis } from "../redis/client.js";
import { AppError, errors } from "../errors/index.js";
import { logGame } from "../logging/logger.js";
import { bumpScore, getLeaderboard, removePlayer, setScore } from "../leaderboard/index.js";

// ---------------------------------------------------------------------------
// Key layout
// ---------------------------------------------------------------------------

const stateKey = (id: string) => `game:${id}`;
const playersKey = (id: string) => `game:${id}:players`;
const answersKey = (id: string) => `game:${id}:answers`;
const countsKey = (id: string) => `game:${id}:counts`;
const questionsKey = (id: string) => `game:${id}:questions`;

const GAME_KEEPALIVE_SECONDS = 24 * 60 * 60;

export interface PlayerRecord {
  nickname: string;
  score: number;
  connected: boolean;
  joinedAt: number;
}

export interface QuestionSnapshotOption {
  id: string;
  text: string;
}

export interface QuestionSnapshot {
  id: string;
  text: string;
  timeLimit: number;
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
  currentQuestionId: string | null;
  questionStartedAt: number | null;
  questionEndsAt: number | null;
  questionNumber: number;
  totalQuestions: number;
  answerCount: number;
  resultQuestionId: string | null;
  correctOptionId: string | null;
}

export const PHASE_DEFAULT = "LOBBY";

// ---------------------------------------------------------------------------
// Lua scripts (atomic state transitions). Loaded once per process.
// ---------------------------------------------------------------------------

const LUA = {
  startQuestion: `
local state = KEYS[1]
local phase = redis.call("HGET", state, "phase")
if phase ~= "LOBBY" and phase ~= "QUESTION_RESULTS" then
  return redis.error_reply("INVALID_TRANSITION")
end
redis.call("HSET", state,
  "phase", "QUESTION_ACTIVE",
  "currentQuestionId", ARGV[1],
  "questionStartedAt", ARGV[2],
  "questionEndsAt", ARGV[3],
  "questionNumber", ARGV[4],
  "totalQuestions", ARGV[5],
  "answerCount", 0,
  "resultQuestionId", "",
  "correctOptionId", "")
return redis.call("HGETALL", state)`,
  submitAnswer: `
local state = KEYS[1]
local answers = KEYS[2]
local counts = KEYS[3]
local phase = redis.call("HGET", state, "phase")
local current = redis.call("HGET", state, "currentQuestionId")
local endsAt = redis.call("HGET", state, "questionEndsAt")
if phase ~= "QUESTION_ACTIVE" or current ~= ARGV[2] then
  return redis.error_reply("QUESTION_NOT_ACTIVE")
end
if tonumber(ARGV[4]) > tonumber(endsAt) then
  return redis.error_reply("ANSWER_TOO_LATE")
end
local key = ARGV[1] .. ":" .. ARGV[2]
if redis.call("HEXISTS", answers, key) == 1 then
  return redis.error_reply("ALREADY_ANSWERED")
end
redis.call("HSET", answers, key, ARGV[3] .. "," .. ARGV[4] .. "," .. ARGV[5])
redis.call("HINCRBY", counts, ARGV[2] .. ":" .. ARGV[3], 1)
redis.call("HINCRBY", state, "answerCount", 1)
return { redis.call("HGET", state, "answerCount") }`,
  endQuestion: `
local state = KEYS[1]
local counts = KEYS[2]
local phase = redis.call("HGET", state, "phase")
if phase ~= "QUESTION_ACTIVE" then
  return redis.error_reply("QUESTION_NOT_ACTIVE")
end
local qid = redis.call("HGET", state, "currentQuestionId")
redis.call("HSET", state,
  "phase", "QUESTION_RESULTS",
  "resultQuestionId", qid,
  "correctOptionId", ARGV[1])
local answerCount = redis.call("HGET", state, "answerCount")
local flat = redis.call("HGETALL", counts)
local result = {}
local n = 1
for i = 1, #flat, 2 do
  local field = flat[i]
  local sep = string.find(field, ":")
  if sep and string.sub(field, 1, sep - 1) == qid then
    result[n] = { optionId = string.sub(field, sep + 1), count = flat[i + 1] }
    n = n + 1
  end
end
return { qid, ARGV[1], tostring(answerCount or 0), cjson.encode(result) }`,
  finishGame: `
local state = KEYS[1]
local phase = redis.call("HGET", state, "phase")
if phase == "FINISHED" then
  return redis.error_reply("GAME_FINISHED")
end
redis.call("HSET", state, "phase", "FINISHED")
local players = KEYS[2]
local playersCount = redis.call("HLEN", players)
return { "FINISHED", tostring(playersCount or 0) }`,
};

interface LuaCmd {
  startQuestion: (...args: (string | number)[]) => Promise<string[]>;
  submitAnswer: (...args: (string | number)[]) => Promise<string[]>;
  endQuestion: (...args: (string | number)[]) => Promise<string[]>;
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
    case "submitAnswer":
      return 3;
    case "endQuestion":
    case "finishGame":
      return 2;
    default:
      return 1;
  }
}

function parseLuaReplyError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("INVALID_TRANSITION")) return errors.invalidTransition();
  if (message.includes("QUESTION_NOT_ACTIVE")) return errors.questionNotActive();
  if (message.includes("ANSWER_TOO_LATE")) return errors.answerTooLate();
  if (message.includes("ALREADY_ANSWERED")) return errors.alreadyAnswered();
  if (message.includes("GAME_FINISHED")) return errors.gameFinished();
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
    currentQuestionId: row.currentQuestionId || null,
    questionStartedAt: row.questionStartedAt ? Number(row.questionStartedAt) : null,
    questionEndsAt: row.questionEndsAt ? Number(row.questionEndsAt) : null,
    questionNumber: Number(row.questionNumber ?? 0),
    totalQuestions: Number(row.totalQuestions ?? 0),
    answerCount: Number(row.answerCount ?? 0),
    resultQuestionId: row.resultQuestionId || null,
    correctOptionId: row.correctOptionId || null,
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
  },
  questions: QuestionsSnapshot,
): Promise<void> {
  ensureScripts();
  const pipe = redis.multi();
  pipe.del(playersKey(meta.gameId), answersKey(meta.gameId), countsKey(meta.gameId));
  pipe.hset(stateKey(meta.gameId), {
    gameId: meta.gameId,
    joinCode: meta.joinCode,
    quizId: meta.quizId,
    quizTitle: meta.quizTitle,
    hostUserId: meta.hostUserId,
    phase: PHASE_DEFAULT,
    hostConnected: "0",
    currentQuestionId: "",
    questionStartedAt: "",
    questionEndsAt: "",
    questionNumber: "0",
    totalQuestions: String(questions.list.length),
    answerCount: "0",
    resultQuestionId: "",
    correctOptionId: "",
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
    countsKey(gameId),
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
    // state keys are exactly game:{id}; players/answers/counts/questions have extra segments
    if (parts.length === 2 && parts[0] === "game" && parts[1]) {
      ids.push(parts[1]);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Phase transitions (Phase 3) — atomic in Lua
// ---------------------------------------------------------------------------

export async function startQuestion(
  gameId: string,
  question: QuestionSnapshot,
  questionNumber: number,
  totalQuestions: number,
): Promise<GameStateRow> {
  const now = Date.now();
  const endsAt = now + question.timeLimit * 1000;
  try {
    const flat = (await (redis as unknown as LuaCmd).startQuestion(
      stateKey(gameId),
      question.id,
      now,
      endsAt,
      questionNumber,
      totalQuestions,
    )) as string[];
    await touchGame(gameId);
    logGame("QUESTION_STARTED", { gameId, questionId: question.id, endsAt });
    return parseState(rowsFromFlat(flat as string[]));
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

export async function submitAnswer(
  gameId: string,
  playerId: string,
  questionId: string,
  optionId: string,
  points: number,
): Promise<{ answerCount: number }> {
  const now = Date.now();
  try {
    const reply = (await (redis as unknown as LuaCmd).submitAnswer(
      stateKey(gameId),
      answersKey(gameId),
      countsKey(gameId),
      playerId,
      questionId,
      optionId,
      now,
      points,
    )) as string[];
    return { answerCount: Number(reply[0] ?? 0) };
  } catch (err) {
    throw parseLuaReplyError(err);
  }
}

export interface QuestionCount {
  optionId: string;
  count: number;
}

export async function endQuestion(gameId: string): Promise<{
  questionId: string;
  correctOptionId: string;
  answerCount: number;
  optionCounts: QuestionCount[];
}> {
  try {
    const questions = await getQuestions(gameId);
    const current = await getState(gameId);
    if (!current?.currentQuestionId) throw errors.questionNotActive();
    const correctOptionId = questions.correct[current.currentQuestionId];
    if (!correctOptionId) throw errors.internal("Missing correct answer for active question");
    const reply = (await (redis as unknown as LuaCmd).endQuestion(
      stateKey(gameId),
      countsKey(gameId),
      correctOptionId,
    )) as string[];
    await touchGame(gameId);
    const questionId = reply[0] ?? "";
    const answerCount = Number(reply[2] ?? 0);
    const optionCounts = await getCounts(gameId, questionId);
    logGame("QUESTION_ENDED", { gameId, questionId, answerCount });
    return {
      questionId,
      correctOptionId: reply[1] ?? "",
      answerCount,
      optionCounts,
    };
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
      // Skip corrupt entries; restore repairs from answers if needed.
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
}

export async function setHostConnected(gameId: string, connected: boolean): Promise<void> {
  await redis.hset(stateKey(gameId), "hostConnected", connected ? "1" : "0");
}

export async function addPlayerScore(
  gameId: string,
  playerId: string,
  points: number,
): Promise<number> {
  const record = await getPlayer(gameId, playerId);
  if (!record) return 0;
  record.score += points;
  await redis.hset(playersKey(gameId), playerId, JSON.stringify(record));
  await bumpScore(gameId, playerId, points);
  return record.score;
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
  await removePlayer(gameId, playerId);
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface StoredAnswer {
  playerId: string;
  optionId: string;
  ts: number;
  points: number;
}

export async function getAnswersForQuestion(
  gameId: string,
  questionId: string,
): Promise<StoredAnswer[]> {
  const flat = await redis.hgetall(answersKey(gameId));
  const prefix = `:${questionId}`;
  const answers: StoredAnswer[] = [];
  for (const [field, value] of Object.entries(flat)) {
    const sep = field.lastIndexOf(prefix);
    if (sep <= 0) continue;
    const playerId = field.slice(0, sep);
    const parts = String(value).split(",");
    if (parts.length !== 3) continue;
    answers.push({
      playerId,
      optionId: parts[0]!,
      ts: Number(parts[1]),
      points: Number(parts[2]),
    });
  }
  return answers;
}

export async function getCounts(
  gameId: string,
  questionId: string,
): Promise<QuestionCount[]> {
  const flat = await redis.hgetall(countsKey(gameId));
  const sep = questionId + ":";
  const counts: QuestionCount[] = [];
  for (const [field, value] of Object.entries(flat)) {
    if (!field.startsWith(sep)) continue;
    counts.push({ optionId: field.slice(sep.length), count: Number(value) });
  }
  return counts;
}

export async function getPlayerAnswerForQuestion(
  gameId: string,
  playerId: string,
  questionId: string,
): Promise<StoredAnswer | null> {
  const value = await redis.hget(answersKey(gameId), `${playerId}:${questionId}`);
  if (!value) return null;
  const parts = String(value).split(",");
  if (parts.length !== 3) return null;
  return { playerId, optionId: parts[0]!, ts: Number(parts[1]), points: Number(parts[2]) };
}

export async function countAnswersForPlayer(
  gameId: string,
  playerId: string,
): Promise<number> {
  const flat = await redis.hgetall(answersKey(gameId));
  let count = 0;
  for (const field of Object.keys(flat)) {
    if (field.startsWith(`${playerId}:`)) count += 1;
  }
  return count;
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