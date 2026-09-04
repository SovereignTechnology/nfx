import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      {
        // Black-box tests for the repo tooling in scripts/ (lane L9).
        test: {
          name: 'scripts',
          include: ['scripts/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/contracts/**'],
    },
  },
});
