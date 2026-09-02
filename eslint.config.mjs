import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'packages/db/prisma/migrations/**',
      '.osm-cache/**',
      'osm-data/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },

  // Server-side packages: Node globals, console is the logger's business only.
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'packages/db/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Web: browser globals plus React hook and fast-refresh rules.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Build and bootstrap scripts are Node programs whose whole job is to print
  // what they did.
  {
    files: ['**/scripts/**/*.{ts,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Config files run in Node even inside the web app.
  {
    files: ['**/*.config.{ts,mts,js,mjs}', '**/vitest.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  prettier,
);
