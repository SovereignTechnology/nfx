import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'seeder',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    environment: 'node',
  },
});
