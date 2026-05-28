import tseslint from 'typescript-eslint';

const sourceFilePatterns = [
  'apps/**/*.{ts,tsx}',
  'packages/**/*.{ts,tsx}',
  'scripts/**/*.ts'
];

const googleStyleRules = {
  'brace-style': ['error', '1tbs', { allowSingleLine: true }],
  curly: ['error', 'all'],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-debugger': 'error',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  quotes: ['error', 'single', { avoidEscape: true }],
  semi: ['error', 'always']
};

const pragmaticTypeScriptRules = {
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { fixStyle: 'separate-type-imports' }
  ],
  '@typescript-eslint/no-explicit-any': 'error'
};

export default [
  {
    ignores: [
      '.next/**',
      'apps/web/.next/**',
      'apps/web/next-env.d.ts',
      'coverage/**',
      'dist/**',
      'docs/**',
      'node_modules/**'
    ]
  },
  {
    files: sourceFilePatterns,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      ...googleStyleRules,
      ...pragmaticTypeScriptRules
    }
  }
];
