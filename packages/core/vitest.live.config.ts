import { defineConfig } from 'vitest/config';

/**
 * Live smoke tests only — real endpoints, real keys, real cost. Kept in a
 * separate config so the default `vitest run` cannot pick them up by accident.
 * Each suite skips itself when its key is missing, so running this without
 * credentials is a no-op rather than a wall of failures.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/**/*.live.test.ts'],
    // A provider round-trip is slower than anything else in the suite, and a
    // tool loop is several of them.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Serial: parallel calls on one key invite rate limits, and a 429 here
    // would read as a bug in the SDK rather than a quota.
    fileParallelism: false,
    retry: 0,
  },
});
