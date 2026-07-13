import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Tooling artifacts that must never gate CI:
    ".claude/**",
    ".data/**",
    "public/**",
    "clawhub/**",
  ]),
  {
    rules: {
      // Legacy debt tracked for cleanup, not a merge blocker: ~330 `any`s
      // predate strict linting. New code should still avoid `any` (warn).
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // CommonJS test files and Node scripts legitimately use require().
    files: ["**/*.cjs", "scripts/**", "tests/**"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
