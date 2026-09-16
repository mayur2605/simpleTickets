import js from "@eslint/js";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import a11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": hooks, "jsx-a11y": a11y },
    rules: {
      ...hooks.configs.recommended.rules,
      ...a11y.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // A horizontally scrollable container must be focusable, or keyboard-only
      // users cannot scroll it (WCAG 2.1.1 Keyboard). Allow a tab stop on
      // role="region" only; every other non-interactive element stays banned.
      "jsx-a11y/no-noninteractive-tabindex": [
        "error",
        {
          tags: [],
          roles: ["tabpanel", "region"],
          allowExpressionValues: true,
        },
      ],
    },
  },
  {
    files: ["checks/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
