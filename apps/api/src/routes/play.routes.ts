import type { FastifyInstance } from "fastify";
import { PlayerJoinDto } from "@quiz/shared";
import { parseWith } from "../errors/index.js";
import { joinGame } from "../players/service.js";

export const playRoutes = async (app: FastifyInstance): Promise<void> => {
  /**
   * Join a live game. Public (no host auth). Sets the httpOnly player cookie
   * on success; the client then opens its Socket.IO connection, which resolves
   * the player from that cookie and attaches it to the game room.
   */
  app.post("/play/join", async (req, reply) => {
    const body = parseWith(PlayerJoinDto, req.body);
    const outcome = await joinGame(req, reply, body);
    return reply.send({ join: outcome.result });
  });
};