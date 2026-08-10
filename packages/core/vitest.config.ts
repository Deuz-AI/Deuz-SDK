import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Core is runtime-agnostic; node env provides fetch/Web Streams via undici.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Live smoke tests hit real provider endpoints and cost money. They run
    // only through `npm run test:live`, never as part of `npm test` or CI.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/live/**'],
    // Type-level surface lock runs via `npm run test:types`.
    typecheck: {
      enabled: false,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
    coverage: { provider: 'v8', include: ['src/**'] },
    // NOTE: never combine vi.useFakeTimers() with MSW (v2 microtask queue breaks).
  },
});
