import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LoginDto, RegisterDto, type UserDto } from "@quiz/shared";
import { prisma } from "../db/client.js";
import { AppError, isUniqueViolation, parseWith } from "../errors/index.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  setSessionCookie,
} from "../auth/plugin.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";

function toUserDto(user: { id: string; email: string; name: string; role: string }): UserDto {
  return { id: user.id, email: user.email, name: user.name, role: user.role as UserDto["role"] };
}

async function issueSession(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  const token = await createSession(userId, {
    ip: req.ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
  });
  setSessionCookie(reply, token);
}

export interface AuthRouteOptions {
  rateLimit?: { loginMax?: number; registerMax?: number };
}

export const authRoutes = async (app: FastifyInstance, opts?: AuthRouteOptions): Promise<void> => {
  const loginMax = opts?.rateLimit?.loginMax ?? 30;
  const registerMax = opts?.rateLimit?.registerMax ?? 30;

  app.post("/auth/register", { config: { rateLimit: { max: registerMax, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parseWith(RegisterDto, req.body);
    const passwordHash = await hashPassword(body.password);
    let user;
    try {
      user = await prisma.user.create({
        data: { email: body.email, name: body.name, passwordHash },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("CONFLICT", "Email already registered", 409);
      throw e;
    }
    await issueSession(req, reply, user.id);
    return reply.status(201).send({ user: toUserDto(user) });
  });

  app.post("/auth/login", { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parseWith(LoginDto, req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      throw new AppError("UNAUTHORIZED", "Invalid email or password", 401);
    }
    await issueSession(req, reply, user.id);
    return reply.send({ user: toUserDto(user) });
  });

  app.post("/auth/logout", async (req, reply) => {
    await destroySession(req);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get("/auth/me", async (req) => {
    const user = requireAuth(req);
    return { user: toUserDto(user) };
  });
};