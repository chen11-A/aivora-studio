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
    testTimeout: process.platform === "win32" ? 20_000 : 10_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    pool: "forks",
    ...(process.platform === "win32"
      ? { poolOptions: { forks: { maxForks: 2, minForks: 1 } } }
      : {}),
  },
});
