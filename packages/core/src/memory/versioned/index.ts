/**
 * `@deuz-sdk/core/memory/versioned` (2.4): versioned, provenance-tracked
 * memory. Records keep a stable id and increasing revisions, carry their
 * sources and an `asserted | inferred` origin, and change only through
 * operations with receipts (idempotent replay, compare-and-set, atomic
 * commit). `forget` removes content and tells V3 run stores to redact it.
 * The legacy `@deuz-sdk/core/memory` seam is unchanged. Edge-safe; the SQLite
 * and PostgreSQL stores live at `/memory/versioned/sqlite` and `/postgres`.
 */
import { notImplemented } from '../../internal/not-implemented';
import type { ImportLegacyMemoryOptions, ImportLegacyMemoryResult } from './types';

export type * from './types';
export type {
  AccountedEmbeddings,
  AccountedMemoryEmbedder,
  AccountedMemoryLLM,
  AccountedMemoryLLMResult,
  AccountedUsage,
  CallAccounting,
} from '../../types/accounting';
export type { ConflictSubsystem } from '../../errors';
export {
  EmbeddingMismatchError,
  OperationConflictError,
  RevisionConflictError,
} from '../../errors';
export { defineAccountedMemoryLLM, isAccounted } from '../../internal/accounting';
export { createInMemoryVersionedMemoryStore } from './store';
export { createMemorySession } from './session';
export { createVersionedMemoryTools } from './tools';

/**
 * Imports a legacy `MemoryStore` scope into a versioned store (2.4): each
 * legacy record becomes revision 1 under operation `<prefix>:<legacy id>`, so
 * running it again replays instead of duplicating. Expired and invalidated
 * records are skipped; vectors are not carried over (re-embed instead).
 */
export async function importLegacyMemory(
  _options: ImportLegacyMemoryOptions,
): Promise<ImportLegacyMemoryResult> {
  return notImplemented('importLegacyMemory');
}
