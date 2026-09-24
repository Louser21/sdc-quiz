import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlayerJoinDto, PlayerJoinResultDto } from "@quiz/shared";
import { prisma } from "../db/client.js";
import { errors, isUniqueViolation } from "../errors/index.js";
import * as store from "../game/store.js";
import { buildPlayerState } from "../game/state.js";
import { hostRoom } from "../sockets/rooms.js";
import { getIo } from "../sockets/instance.js";
import { getLogger, logGame } from "../logging/logger.js";
import {
  generatePlayerToken,
  hashPlayerToken,
  resolvePlayerFromCookieHeader,
  setPlayerSessionCookie,
} from "./session.js";

const JOINGAME_READY_GAME_STATUSES = new Set(["CREATED", "ACTIVE"]);

export interface JoinGameOutcome {
  result: PlayerJoinResultDto;
  /** True when the player was rejoining (same device cookie, same game). */
  rejoined: boolean;
}

/**
 * Join a live game (Phase 2). Serves double duty:
 *  - brand-new players: mint an httpOnly player cookie + Player row (unique
 *    `(gameId, nickname)`, so the same nickname cannot be taken by another
 *    device) then attach them to the Redis lobby;
 *  - returning devices: the same cookie rejoins the same game — they keep
 *    their score and identity (this is the reconnect path after a refresh).
 *
 * Identity is the cookie, NOT the socket. A player who disconnects and
 * reconnects (or refreshes) stays the same player.
 */
export async function joinGame(
  req: FastifyRequest,
  reply: FastifyReply,
  input: PlayerJoinDto,
): Promise<JoinGameOutcome> {
  const gameCode = input.gameCode.toUpperCase();

  const session = await prisma.gameSession.findUnique({
    where: { joinCode: gameCode },
    include: { quiz: { select: { title: true } } },
  });
  if (!session) throw errors.invalidGameCode("No game found with that code");
  if (!JOINGAME_READY_GAME_STATUSES.has(session.status)) {
    if (session.status === "FINISHED") throw errors.gameFinished("That game has already finished");
    throw errors.gameNotJoinable("That game is not accepting players right now");
  }

  // The live state must exist in Redis; if not (crashed game), refuse to join
  // rather than joining a half-broken game. (Phase 4 recovery restores it.)
  const state = await store.getState(session.id);
  if (!state) throw errors.invalidGameCode("That game is not currently running");
  if (state.phase === "FINISHED") throw errors.gameFinished("That game has already finished");

  const existing = await resolvePlayerFromCookieHeader(req.headers.cookie);
  const rejoin =
    existing !== null && existing.gameId === session.id && session.status !== "FINISHED";

  // Fresh joiners are welcome only while the paper is still in the lobby;
  // returning devices keep re-joining throughout the paper to restore their state.
  if (!rejoin && state.phase !== "LOBBY") {
    throw errors.gameNotJoinable("That paper has already started");
  }

  let playerId: string;
  let sessionId: string;
  let rejoined = rejoin;

  if (rejoin) {
    playerId = existing!.playerId;
    sessionId = existing!.sessionId;
    // Nickname may have changed on the join form; enforce uniqueness again.
    try {
      await prisma.player.update({
        where: { id: playerId },
        data: {
          nickname: input.nickname,
          lastSeenAt: new Date(),
          status: "ACTIVE",
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.nicknameTaken();
      throw err;
    }
  } else {
    // New identity (first join, or joining a different game).
    const token = generatePlayerToken();
    sessionId = hashPlayerToken(token);
    try {
      const created = await prisma.player.create({
        data: {
          gameId: session.id,
          sessionId,
          nickname: input.nickname,
        },
        select: { id: true },
      });
      playerId = created.id;
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.nicknameTaken();
      throw err;
    }
    setPlayerSessionCookie(reply, token);
  }

  // Attach to the Redis lobby (preserve any existing score/submission on rejoin).
  const existingRecord = await store.getPlayer(session.id, playerId);
  await store.upsertPlayer(session.id, playerId, {
    nickname: input.nickname,
    score: existingRecord?.score ?? 0,
    connected: true,
    submitted: existingRecord?.submitted ?? false,
    submittedAt: existingRecord?.submittedAt ?? null,
    joinedAt: existingRecord?.joinedAt ?? Date.now(),
  });

  // Notify the host lobby immediately.
  getIo()
    .to(hostRoom(session.id))
    .emit("host:player-updated", {
      playerId,
      nickname: input.nickname,
      connected: true,
      submitted: existingRecord?.submitted ?? false,
    });

  logGame(rejoined ? "PLAYER_REJOINED" : "PLAYER_JOINED", {
    gameId: session.id,
    playerId,
    nickname: input.nickname,
  });

  const result: PlayerJoinResultDto = {
    gameId: session.id,
    joinCode: session.joinCode,
    quizTitle: session.quiz.title,
    player: { playerId, nickname: input.nickname, totalPoints: existingRecord?.score ?? 0 },
    state: await buildPlayerState(session.id, playerId),
  };

  if (!rejoin) {
    getLogger().info(
      { gameId: session.id, playerId, joinCode: session.joinCode },
      "player session issued",
    );
  }

  return { result, rejoined };
}