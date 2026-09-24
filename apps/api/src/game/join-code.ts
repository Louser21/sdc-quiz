import { randomInt } from "node:crypto";
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH } from "@quiz/shared";
import { prisma } from "../db/client.js";
import { errors } from "../errors/index.js";

/** Generate a random join code from the unambiguous alphabet. */
export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** Create a join code guaranteed to be unique against existing sessions. */
export async function createUniqueJoinCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateJoinCode();
    const existing = await prisma.gameSession.findUnique({ where: { joinCode: code } });
    if (!existing) return code;
  }
  throw errors.internal("Could not allocate a unique join code");
}