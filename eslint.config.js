import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'coverage/**',
      // Build products: electron-builder output and the staged native helper.
      '**/release/**',
      'apps/*/resources/**',
      // Transient worktrees of parallel agent sessions: linting them reads
      // another session's half-written files and fails at random.
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Fakes and tests may use non-null assertions on fixture data they own.
    files: ['**/test/**/*.ts', '**/test/**/*.tsx', '**/src/fakes/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The Electron renderer runs in Chromium, not Node.
    files: ['apps/*/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Build scripts are plain Node ESM, not part of any tsconfig, and they talk
    // to the operator on stdout — that is their entire job.
    files: ['apps/*/scripts/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
