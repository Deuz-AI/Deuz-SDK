/**
 * The PostgreSQL durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/stores/postgres`: new tables with their own
 * `deuz_stream_state_schema` version table; a batch and its fencing check
 * share one pinned transaction. Node-only.
 */
import type { DurableStreamStateStore } from '../types/stream-durable';
import { notImplemented } from '../internal/not-implemented';
import type { PostgresConnectionOptions } from './store-connection';

/** Options of `createPostgresDurableStreamStateStore`. */
export type PostgresDurableStreamStateStoreOptions = PostgresConnectionOptions;

/** The PostgreSQL durable stream state store (2.4). */
export function createPostgresDurableStreamStateStore(
  _options: PostgresDurableStreamStateStoreOptions,
): DurableStreamStateStore & { migrate(): Promise<void>; close(): Promise<void> } {
  return notImplemented('createPostgresDurableStreamStateStore');
}
