/**
 * store-conformance-reference.test.ts — the shared contract suites, run against
 * the three REFERENCE in-memory backends.
 *
 * This file exists to prove the suites themselves: `test/fixtures/store-
 * conformance.ts` is consumed by the SQLite / Redis / Postgres store tests, so a
 * bug in an assertion there would show up as a false red (or, worse, a false
 * green) in three unrelated files at once. `createInMemoryMemoryStore` /
 * `createInMemoryChatStore` / `createInMemorySessionStore` are the semantics
 * every other backend is a port of, so if the suites do not pass here they are
 * wrong, not the backend.
 */
import { createInMemoryMemoryStore } from '../src/memory';
import { createInMemoryChatStore } from '../src/chat';
import { createInMemorySessionStore } from '../src/durable';
import {
  assertMemoryStoreContract,
  assertChatStoreContract,
  assertSessionStoreContract,
} from './fixtures/store-conformance';

// No cleanup: each `make()` builds a brand-new Map-backed store that the GC
// collects with the test. A persistent backend returns `cleanup` instead.
assertMemoryStoreContract('in-memory (reference)', async () => ({
  store: createInMemoryMemoryStore(),
}));

assertChatStoreContract('in-memory (reference)', async () => ({
  store: createInMemoryChatStore(),
}));

assertSessionStoreContract('in-memory (reference)', async () => ({
  store: createInMemorySessionStore(),
}));
