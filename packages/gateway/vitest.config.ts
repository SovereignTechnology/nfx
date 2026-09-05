import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'gateway',
    // Only `*.test.ts` are suites; helpers under `__tests__/` (fakes, fixtures) are not.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
