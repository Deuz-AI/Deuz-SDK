/**
 * `@deuz-sdk/core/memory/versioned/postgres` (2.4): the versioned memory store
 * on PostgreSQL (`pg` peer). New tables with their own `deuz_vmem_schema`
 * version table; the legacy pack's tables and migrate versions are untouched.
 * Hybrid search (`tsvector` + vector, RRF) for parity with SQLite; pgvector
 * stays optional, with in-process cosine over a bounded candidate set without
 * it. Each commit pins one pooled connection. Node-only.
 */
import type { VersionedMemoryStore } from '../memory/versioned/types';
import { notImplemented } from '../internal/not-implemented';
import type { PostgresConnectionOptions } from './store-connection';

/** Options of `createPostgresVersionedMemoryStore`. */
export type PostgresVersionedMemoryStoreOptions = PostgresConnectionOptions & {
  /** `'auto'` (default) uses pgvector when installed; `'require'` refuses without it; `'off'` never probes. */
  pgvector?: 'auto' | 'require' | 'off';
  /** Rows scored in process without pgvector. Default 1000. */
  candidateLimit?: number;
};

/** A PostgreSQL `VersionedMemoryStore` with an explicit `migrate`. */
export type PostgresVersionedMemoryStore = VersionedMemoryStore & {
  /** Creates or patches the schema; idempotent, memoized, retried after a failure. */
  migrate(): Promise<void>;
  close(): Promise<void>;
};

/** The PostgreSQL versioned memory store (2.4). */
export function createPostgresVersionedMemoryStore(
  _options: PostgresVersionedMemoryStoreOptions,
): PostgresVersionedMemoryStore {
  return notImplemented('createPostgresVersionedMemoryStore');
}
