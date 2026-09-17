import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// The same gate the Cloudflare worker had, and the same one prototype/ has:
// strict type-aware rules, zero warnings, no explicit any, no non-null
// assertions (docs/engineering-standards.md, T028). Deliberately NOT widened
// during the migration - a port is the wrong moment to change what "green"
// means, because then a new failure cannot be told from a new rule.
//
// The one change is `globals`: this runs on Node now, so the browser globals
// the Workers build needed are gone.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "var/**"] },
  {
    files: ["src/**/*.ts", "*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
