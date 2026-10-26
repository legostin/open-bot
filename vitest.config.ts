import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "plugins/*/server/**/*.test.ts", "plugins/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    testTimeout: 20000,
    pool: "forks",
    // Messages are asserted in English; a developer's own LANG must not change them.
    env: { OPENBOT_LANG: "en" },
  },
});
