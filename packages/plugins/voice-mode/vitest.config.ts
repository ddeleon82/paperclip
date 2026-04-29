import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    globals: true,
    setupFiles: ["./src/ui/test-setup.ts"],
    env: {
      NODE_ENV: "development",
    },
  },
});
