import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'seeder',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
