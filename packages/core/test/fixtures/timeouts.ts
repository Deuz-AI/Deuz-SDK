/**
 * Timeouts for the slow tests (2.4): SQLite file databases and live servers.
 *
 * A SQLite file opened, migrated and reopened ran 11.6 s on a hosted Windows
 * runner (2.3), past vitest's 5 s default; a live Postgres or Redis pays a
 * network round trip per statement and real waits for server time. Logic tests
 * use `:memory:` and keep the default; these are for the tests that cannot.
 */

/** A test on a SQLite file or a live server. */
export const SLOW_TEST_TIMEOUT_MS = 30_000;

/** A hook that starts, connects to or cleans up a live server. */
export const SLOW_HOOK_TIMEOUT_MS = 60_000;
