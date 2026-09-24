import type { FastifyInstance } from "fastify";
import { PlayerJoinDto } from "@quiz/shared";
import { parseWith } from "../errors/index.js";
import { joinGame } from "../players/service.js";

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
};