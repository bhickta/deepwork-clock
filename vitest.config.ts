import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    include: [
      "tests/**/*.{test,spec}.ts",
      "src/**/*.{test,spec}.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src-tauri/**",
      // Playwright specs live outside vitest's default roots and use a *.e2e.ts suffix.
      "scripts/e2e/**",
    ],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
