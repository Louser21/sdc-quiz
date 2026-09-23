import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "integration/**/*.test.ts"],
    globalSetup: "./integration/global-setup.ts",
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});