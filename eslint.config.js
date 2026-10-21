import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for Deepwork Clock.
 *
 * Scope: TypeScript sources (frontend + tests) and Node tooling scripts.
 * Type-aware linting is intentionally not enabled for the whole project to keep
 * lint runs fast and independent of the Cargo build; the strict TypeScript
 * compiler (`npm run typecheck`) is the type-safety gate.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // The bridge boundary must never use `any` (PLAN.md section 7).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js", "*.config.js", "*.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["scripts/e2e/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
