import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@main": resolve("src/main"),
      "@renderer": resolve("src/renderer"),
    },
  },
  test: {
    environment: "node",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    pool: "forks",
    ...(process.platform === "win32" || process.env.CI
      ? { poolOptions: { forks: { maxForks: 2, minForks: 1 } } }
      : {}),
  },
});
