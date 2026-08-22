import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    env: {
      QWEN_DISABLE_CONFIG_FALLBACKS: "1",
      QWEN_CONFIG_FILE: "",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
        "src/upload.ts": {
          lines: 85,
          functions: 90,
          branches: 75,
          statements: 85,
        },
      },
    },
  },
});
