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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    pool: process.platform === "win32" ? "threads" : "forks",
    ...(process.platform === "win32"
      ? { poolOptions: { threads: { maxThreads: 2, minThreads: 1 } } }
      : {}),
  },
});
