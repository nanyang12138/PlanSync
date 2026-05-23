import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    // .mjs files under packages/*/src run on Node (e.g. exec-cli.mjs, the
    // standalone shell entry for `bin/plansync --exec`) so they need node
    // globals (process, Buffer, URL, …).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // R-133: `no-explicit-any` is re-enabled at warn level after migrating
      // legacy `any` usages in errors.ts, AI prompt builders, AI client, and
      // mcp-server boundary types to `unknown` + narrowing. The repo lint
      // script enforces `--max-warnings 0`, so new `any` usage will fail CI.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**'],
  },
];
