/**
 * The in-memory durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/ui`. The contract is in `types/stream-durable.ts`.
 * Edge-safe.
 */
import type { Dependencies } from './types/deps';
import type { DurableStreamStateStore } from './types/stream-durable';
import { notImplemented } from './internal/not-implemented';

/** The coalescing defaults of the durable serializer: 20 ms or 16 KiB, whichever first. */
export const DEFAULT_DURABLE_STREAM_BATCH = { maxDelayMs: 20, maxBytes: 16_384 } as const;

/**
 * The in-memory `DurableStreamStateStore` (2.4, preview): commits are atomic
 * per batch, fenced by the highest token a producer opened the stream with.
 */
export function createInMemoryDurableStreamStateStore(_options?: {
  deps?: Dependencies;
}): DurableStreamStateStore {
  return notImplemented('createInMemoryDurableStreamStateStore');
}
