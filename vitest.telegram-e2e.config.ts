import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};

// Telegram media E2E files are test-harness heavy and have historically been
// sensitive to shared worker state. Keep this runner intentionally serial while
// still using process forks for file isolation.
const exclude = (baseTest.exclude ?? []).filter((pattern) => pattern !== "**/*.e2e.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    include: ["extensions/telegram/src/*.e2e.test.ts"],
    exclude,
  },
});
