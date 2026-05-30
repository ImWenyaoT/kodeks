import tseslint from "typescript-eslint";

const sourceFilePatterns = [
  "apps/**/*.{ts,tsx}",
  "packages/**/*.{ts,tsx}",
  "scripts/**/*.ts",
];

export default [
  {
    ignores: [
      ".next/**",
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
