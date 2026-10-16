/**
 * The rollback suite (2.4 spec §4.2, §5.3): `npm run test:rollback -w @deuz-sdk/core`.
 *
 * Its own config, because it installs `@deuz-sdk/core@2.3.0` from npm, which
 * the offline `npm test` must never do; the main config only collects
 * `*.test.ts`, so these `*.spec.ts` files stay out of it.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/rollback/**/*.spec.ts'],
    // A first install from npm, then file databases, a live server and a child process.
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
