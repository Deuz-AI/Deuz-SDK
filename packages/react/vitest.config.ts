import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hooks/components run against the DOM; jsdom provides it.
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
