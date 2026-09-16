import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Matches prototype/eslint.config.mjs: strict type-aware rules, zero warnings,
// no explicit any, no non-null assertions. docs/engineering-standards.md
// requires the same gate on the backend as the frontend (T028).
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".wrangler/**"] },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
