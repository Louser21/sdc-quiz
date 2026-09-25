import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgresql://quiz:quiz@localhost:5432/quiz",
  SESSION_SECRET: "0123456789abcdef",
};

describe("loadConfig", () => {
  it("applies the safe local-development defaults", () => {
    const cfg = loadConfig({ ...base, NODE_ENV: "development" });
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.API_PORT).toBe(3001);
    expect(cfg.SCORE_BASE).toBe(1000);
    expect(cfg.RATE_LIMIT_GLOBAL_MINUTE).toBe(600);
    expect(cfg.RATE_LIMIT_JOIN_MINUTE).toBe(120);
    expect(cfg.SESSION_TTL_DAYS).toBe(30);
    expect(cfg.DEFAULT_QUIZ_TIME_LIMIT_SECONDS).toBe(600);
  });

  it("coerces numeric strings into numbers", () => {
    const cfg = loadConfig({ ...base, SCORE_BASE: "750", API_PORT: "4000" });
    expect(cfg.SCORE_BASE).toBe(750);
    expect(cfg.API_PORT).toBe(4000);
  });

  it("parses the RATE_LIMIT_ENABLED toggle truthy/falsy", () => {
    expect(loadConfig({ ...base, RATE_LIMIT_ENABLED: "false" }).RATE_LIMIT_ENABLED).toBe(false);
    expect(loadConfig({ ...base, RATE_LIMIT_ENABLED: "0" }).RATE_LIMIT_ENABLED).toBe(false);
    expect(loadConfig({ ...base, RATE_LIMIT_ENABLED: "true" }).RATE_LIMIT_ENABLED).toBe(true);
    expect(loadConfig({ ...base, RATE_LIMIT_ENABLED: "1" }).RATE_LIMIT_ENABLED).toBe(true);
    // When absent the toggle defaults to enabled.
    expect(loadConfig({ ...base, RATE_LIMIT_ENABLED: undefined }).RATE_LIMIT_ENABLED).toBe(true);
    // Any other value is rejected rather than silently accepted.
    expect(() => loadConfig({ ...base, RATE_LIMIT_ENABLED: "on" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("splits FRONTEND_ORIGIN on commas into an allow-list", () => {
    const cfg = loadConfig({
      ...base,
      FRONTEND_ORIGIN: "http://a.example, http://b.example , ,http://c.example",
    });
    expect(cfg.FRONTEND_ORIGIN).toEqual(["http://a.example", "http://b.example", "http://c.example"]);
  });

  it("rejects a short session secret with a readable error", () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: "short" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "stagingish" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("enforces the quiz time-limit bounds (60s–120min at the route layer, <=7200 in config)", () => {
    expect(() => loadConfig({ ...base, DEFAULT_QUIZ_TIME_LIMIT_SECONDS: 7201 })).toThrow(
      /Invalid environment configuration/,
    );
    expect(loadConfig({ ...base, DEFAULT_QUIZ_TIME_LIMIT_SECONDS: 60 }).DEFAULT_QUIZ_TIME_LIMIT_SECONDS).toBe(60);
  });
});