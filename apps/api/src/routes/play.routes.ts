import type { FastifyInstance } from "fastify";
import { PlayerJoinDto } from "@quiz/shared";
import { parseWith } from "../errors/index.js";
import { joinGame } from "../players/service.js";
import { resolvePlayerFromCookieHeader } from "../players/session.js";
import { prisma } from "../db/client.js";
import * as store from "../game/store.js";

export interface PlayRouteOptions {
  rateLimit?: { joinMax?: number };
}

export const playRoutes = async (app: FastifyInstance, opts?: PlayRouteOptions): Promise<void> => {
  const joinMax = opts?.rateLimit?.joinMax ?? 120;
  /**
   * Join a live game. Public (no host auth). Sets the httpOnly player cookie
   * on success; the client then opens its Socket.IO connection, which resolves
   * the player from that cookie and attaches it to the game room.
   */
  app.post("/play/join", { config: { rateLimit: { max: joinMax, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parseWith(PlayerJoinDto, req.body);
    const outcome = await joinGame(req, reply, body);
    return reply.send({ join: outcome.result });
  });

  /**
   * Who am I? Resolves the player cookie and returns their CURRENT live game
   * (lobby or started, not finished) so a returning device can resume the
   * paper instead of re-joining from scratch. `me: null` = no active session.
   */
  app.get("/play/me", async (req, reply) => {
    const player = await resolvePlayerFromCookieHeader(req.headers.cookie);
    if (!player) return reply.send({ me: null });
    const session = await prisma.gameSession.findUnique({
      where: { id: player.gameId },
      select: { id: true, joinCode: true, status: true, quiz: { select: { title: true } } },
    });
    const state = await store.getState(player.gameId);
    if (!session || session.status === "FINISHED" || !state || state.phase === "FINISHED") {
      return reply.send({ me: null });
    }
    return reply.send({
      me: {
        playerId: player.playerId,
        gameId: player.gameId,
        joinCode: session.joinCode,
        quizTitle: session.quiz.title,
        phase: state.phase,
        nickname: player.nickname,
      },
    });
  });
};