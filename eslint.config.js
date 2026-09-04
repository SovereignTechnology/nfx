// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'artifacts/**',
      'docs/vendor/**',
      '**/storybook-static/**',
      // Deliberately non-compliant inputs for scripts/electron-security-lint.mjs and csp-sri.mjs.
      'scripts/__fixtures__/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'packages/*/vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Money-path hygiene: nothing in this repo logs by accident.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Contracts are interfaces only. No runtime logic is allowed to live here.
    files: ['packages/core/src/contracts/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration',
          message: 'contracts/ is interfaces only (execution plan §0 rule 1)',
        },
        {
          selector: 'ClassDeclaration',
          message: 'contracts/ is interfaces only (execution plan §0 rule 1)',
        },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts', 'scripts/**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Zero-dependency Node CLIs in scripts/ (lane L9): plain ESM with JSDoc, no TS
    // annotations to require, and Node's Buffer global.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { Buffer: 'readonly', fetch: 'readonly' } },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
