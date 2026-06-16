import { defineConfig } from "vitest/config";

// Retry flaky server suites in CI only. The server tests are timing/race
// sensitive (e.g. heartbeat-process-recovery, environment-service concurrent
// env dedup); a genuine regression fails every attempt, a flake passes on
// retry. We gate on CI so local interactive runs still surface flakes loudly
// instead of masking them. Override with VITEST_RETRY if needed.
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const retry = process.env.VITEST_RETRY
  ? Number.parseInt(process.env.VITEST_RETRY, 10)
  : isCI
    ? 2
    : 0;

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    retry: Number.isNaN(retry) ? 0 : retry,
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
