import js from "@eslint/js";
import tseslint from "typescript-eslint";

const sourceFilePatterns = [
  "apps/**/*.{js,jsx,mjs,ts,tsx,mts,cts}",
  "packages/**/*.{js,jsx,mjs,ts,tsx,mts,cts}",
  "scripts/**/*.{js,mjs,ts,mts,cts}",
];

export default [
  js.configs.recommended,
  {
    ignores: [
      ".next/**",
      ".venv/**",
      "apps/web/.next/**",
      "apps/web/next-env.d.ts",
      "coverage/**",
      "dist/**",
      "docs/**",
      "node_modules/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: sourceFilePatterns,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
];
