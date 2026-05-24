import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Limit worker concurrency so multiple embedded-postgres test files don't
    // race to spin up separate postgres instances simultaneously. Without this
    // cap, "Hook timed out" failures appear when 5+ embedded-postgres suites
    // (heartbeat-*, issues-service, routines-*, etc.) all call initdb at once.
    // 4 workers is enough parallelism for fast unit tests while preventing the
    // startup stampede that caused FRE-947 P0.3 flakes.
    poolOptions: {
      threads: {
        maxThreads: 4,
      },
    },
  },
});
