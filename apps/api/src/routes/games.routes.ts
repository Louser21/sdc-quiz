import type { FastifyInstance } from "fastify";
import { GameCreateDto, GameSessionSummaryDto } from "@quiz/shared";
import { requireAuth } from "../auth/plugin.js";
import { parseWith } from "../errors/index.js";
import * as games from "../games/service.js";

export const gameRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/games", async (req) => {
    const user = requireAuth(req);
    return { games: await games.listGames(user.id) };
  });

  app.post("/games", async (req, reply) => {
    const user = requireAuth(req);
    const body = parseWith(GameCreateDto, req.body);
    const result = await games.createGame(user.id, body.quizId);
    return reply.status(201).send({ game: result });
  });

  app.get("/games/:id", async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    return { game: await games.getGame(user.id, id) };
  });
};

export type { GameSessionSummaryDto };