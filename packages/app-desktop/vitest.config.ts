import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'app-desktop',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    environment: 'jsdom',
  },
});
