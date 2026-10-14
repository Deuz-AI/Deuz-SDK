/**
 * `@deuz-sdk/core/memory/versioned` (2.4): versioned, provenance-tracked
 * memory. Records keep a stable id and increasing revisions, carry their
 * sources and an `asserted | inferred` origin, and change only through
 * operations with receipts (idempotent replay, compare-and-set, atomic
 * commit). `forget` removes content and tells V3 run stores to redact it.
 * The legacy `@deuz-sdk/core/memory` seam is unchanged. Edge-safe; the SQLite
 * and PostgreSQL stores live at `/memory/versioned/sqlite` and `/postgres`.
 */
import type { AgentToolSet } from '../../types/agent-run';
import { notImplemented } from '../../internal/not-implemented';
import type {
  CreateMemorySessionOptions,
  ImportLegacyMemoryOptions,
  ImportLegacyMemoryResult,
  MemorySession,
  VersionedMemoryToolsOptions,
} from './types';

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

/**
 * A memory session over one scope and one store (2.4).
 *
 * - `remember` (host): `origin` defaults to `'asserted'`; with
 *   `supersede: 'reconcile'` (the default) the LLM reconciles against the
 *   `topK` most similar records first, outside the transaction, and the vector
 *   is computed from the final text.
 * - `extract`: only the sources `options.extraction` allows (user messages,
 *   host input, trusted tools by default); every record is `'inferred'` and
 *   cites its messages by id and digest. Same options as `remember`.
 * - Every write commits one operation. A `'conflict'` answer is re-read and
 *   reconciled again, `maxConflictRetries` attempts in all (default 3), then
 *   throws `RevisionConflictError`; the same `operationId` with the same
 *   request returns the stored receipt (`replayed: true`), with another
 *   request throws `OperationConflictError`.
 * - `forget` commits first, then awaits every `onForget` listener in order;
 *   a listener failure leaves `redaction: 'failed'` and never undoes it.
 * - `reembed` is resumable: batches of 64 into a pending generation, records
 *   that changed meanwhile embedded again, the generation activated
 *   atomically once complete. A query vector of another model or size throws
 *   `EmbeddingMismatchError`.
 *
 * Reports `deuz.memory.op` spans (operation, record count, conflict retries,
 * embedding generation) through `deps.observer`.
 */
export function createMemorySession(_options: CreateMemorySessionOptions): MemorySession {
  return notImplemented('createMemorySession');
}

/**
 * The model's memory tools, bound to `session`'s scope (2.4): remember,
 * recall, revise and retract by default (never forget). Every write is
 * `'inferred'`, and a tool can never change a record's scope, origin or
 * source kinds; its operation id derives from the model step and tool call
 * id, so a replayed call never applies twice.
 */
export function createVersionedMemoryTools(
  _session: MemorySession,
  _options?: VersionedMemoryToolsOptions,
): AgentToolSet {
  return notImplemented('createVersionedMemoryTools');
}

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
