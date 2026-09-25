import { describe, expect, it } from "vitest";
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH } from "@quiz/shared";
import { generateJoinCode } from "./join-code.js";

const codePattern = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`);

describe("generateJoinCode", () => {
  it("always emits codes of the fixed length from the unambiguous alphabet", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateJoinCode()).toMatch(codePattern);
    }
  });

  it("never emits confusable characters (0, O, 1, I, L)", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateJoinCode()).not.toMatch(/[01ILO]/);
    }
  });

  it("is spread across the code space (nearly all samples unique)", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateJoinCode()));
    expect(seen.size).toBeGreaterThan(490);
  });
});