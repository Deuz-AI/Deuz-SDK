<!-- verified: 2026-10-16 against @deuz-sdk/core@2.4.0 · api-contract sha256:da3643f44edc
     sources: packages/core/src/memory/versioned/{index,types,session,store,tools,import,policy,accounting}.ts,
     packages/core/src/node/{vmem-sqlite,vmem-postgres,store-connection}.ts, packages/core/src/types/accounting.ts,
     packages/core/src/internal/accounting.ts, packages/core/src/memory.ts, packages/core/src/errors.ts,
     .changeset/{2-4-l1a,2-4-l1b,2-4-fa}.md, docs/content/docs/modules/versioned-memory.mdx (lane D1) -->

# Versioned memory (2.4)

**Load when:** memory must be corrected, audited, shared between writers or forgotten on request — facts with a stable id and revisions, a source for every fact, an `asserted | inferred` origin a model cannot relabel, writes that apply once on retry, a re-embed onto a new model without downtime, or importing the 2.3 `deuz_memory` tables. For the legacy recall/extract seam around `generateText` / `streamChat` (`memory:`), read `references/memory-compaction.md`; it is unchanged and stays the simpler choice when no history is needed.

`@deuz-sdk/core/memory/versioned` is opt-in and edge-safe. Its SQLite and PostgreSQL stores are Node-only: `@deuz-sdk/core/memory/versioned/sqlite` and `@deuz-sdk/core/memory/versioned/postgres`. Docs: [/docs/modules/versioned-memory](/docs/modules/versioned-memory) (2.4).

| Piece | What it is |
| --- | --- |
| `createMemorySession({ store, scope, ... })` | One memory scope: `remember`, `extract`, `recall`, `revise`, `retract`, `forget`, `history`, `reembed` |
| `createInMemoryVersionedMemoryStore()` | The reference `VersionedMemoryStore` (tests, one process) |
| `createSqliteVersionedMemoryStore({ path \| database, wal?, fts?, clock?, logger?, observer? })` | `/memory/versioned/sqlite`; FTS5 (LIKE fallback when FTS5 is missing) fused with cosine |
| `createPostgresVersionedMemoryStore({ pool \| connectionString, schema?, pgvector?, candidateLimit?, clock?, logger?, observer? })` | `/memory/versioned/postgres`; `simple` tsvector + GIN fused with cosine; pgvector `'auto'` (default), `'require'` or `'off'` |
| `createVersionedMemoryTools(session, { include?, prefix? })` | The model's native tools `memory_remember`, `memory_recall`, `memory_revise`, `memory_retract` (never forget) |
| `importLegacyMemory({ from, to, scope })` | A re-runnable import from any legacy `MemoryStore` |
| `RevisionConflictError`, `OperationConflictError`, `EmbeddingMismatchError` | A stale revision, a reused operation id with another request, a vector of another model or size |

## A session, its revisions and a forget

```ts
import { createInMemoryAgentRunStoreV3 } from '@deuz-sdk/core/agent';
import type { Embedder } from '@deuz-sdk/core/memory';
import {
  createInMemoryVersionedMemoryStore,
  createMemorySession,
} from '@deuz-sdk/core/memory/versioned';

// A toy embedder: one dimension per keyword. Use createEmbedder(model) from /memory in production.
const words = ['tea', 'coffee', 'london', 'paris'];
const embedder: Embedder = {
  async embed(texts) {
    return {
      model: 'keywords-1',
      vectors: texts.map((t) => words.map((w) => (t.toLowerCase().includes(w) ? 1 : 0))),
    };
  },
};

const runs = createInMemoryAgentRunStoreV3(); // V3 runs keep compiled context that may cite memory
const memory = createMemorySession({
  store: createInMemoryVersionedMemoryStore(),
  scope: { userId: 'ada' },
  embedder,
  // A forget redacts every stored context package that placed the record.
  onForget: async (event) => {
    await runs.redactForgotten(event);
  },
});

const { records } = await memory.remember({ text: 'Ada lives in London.' });
const fact = records[0]!;
console.log(fact.revision, fact.origin, fact.sources[0]?.kind); // 1 asserted host

const moved = await memory.revise(fact.id, { text: 'Ada lives in Paris.' }, { expectedRevision: 1 });
console.log(moved.records[0]?.revision); // 2

const hits = await memory.recall({ text: 'Where does Ada live? Paris?' });
console.log(hits.map((h) => [h.record.text, h.match])); // [['Ada lives in Paris.', 'hybrid']]

const forgotten = await memory.forget(fact.id);
console.log(forgotten.revisions, forgotten.redaction); // [1, 2] 'complete'
```

## The contract

- **Scope is exact.** A session is bound to one `MemoryScope` (`userId`, `agentId`, `runId`, `actorId`, `chatId`). Reads (`get`, search, history, forget) match it exactly, field order aside; `{ userId: 'ada' }` does not see records written under `{ userId: 'ada', chatId: 'c1' }`, unlike the legacy stores' subset matching. Record ids are unique across the store; creating an id another scope holds conflicts without revealing it.
- **Provenance.** Every `VersionedMemoryRecord` carries `origin` and at least one `MemorySourceRef` (`kind`: `user`, `assistant`, `tool`, `external` or `host`; plus `runId`, `chatId`, `messageId`, `toolCallId`, `toolName`, `uri` and a `sha256:` `digest` of the content as it was read). Only a host `remember` asserts (`origin` defaults to `'asserted'`, `sources` to one `host` source with the text's digest); everything a model extracts or writes is `'inferred'`. A source shows where a fact came from; it never proves it.
- **Operations and receipts.** Every write commits the record, its immutable revision, the index entries and a `VersionedMemoryReceipt` in one transaction, or nothing; an empty or retract-only operation still leaves a receipt, and each commit raises `store.scopeRevision(scope)` by one. Pass `{ operationId }` to make a write idempotent: the same id with the same request returns `replayed: true` without an LLM or embedding call; with another request it throws `OperationConflictError`. Without an id each call is a new operation.
- **Conflicts.** `remember` and `extract` re-read and reconcile again on a concurrent change, `maxConflictRetries` attempts in all (default 3), then throw `RevisionConflictError` (`subsystem: 'memory'`, `expectedRevision`, `actualRevision`, `attempts`). `revise` and `retract` take your `expectedRevision` and throw at once.
- **Reconciliation.** `supersede` defaults to `'reconcile'` when the session has an `llm`, otherwise `'add'`; an explicit `'reconcile'` without one throws `InvalidRequestError`. Reconciliation reads the `topK` (5) most similar active records outside the transaction. An inferred write never revises or retracts an asserted record (an UPDATE becomes a new inferred record linked `about`; a DELETE is dropped); an asserted write over an inferred record retracts it and links the new one `supersedes`; an ADD whose text equals an existing record's (trimmed, case-insensitive) is skipped.
- **Vectors belong to one revision.** The vector is computed from the final text and bound to the revision, the text digest and the embedding generation. A revise that changes the text never keeps the old vector; a retract or a metadata-only revise keeps it. A query or write vector from another model or size throws `EmbeddingMismatchError`, never a zero score. No query embedding is computed before a first generation exists.
- **`recall({ text?, kind?, topK?, recordedAsOf?, includeRetracted? })`** returns `VersionedMemoryHit[]` (`record`, `score`, `match: 'vector' | 'lexical' | 'hybrid'`). `recordedAsOf` returns what the store knew at that time (epoch ms, the store's clock). The context compiler does not send it; a restarted V3 step reads the same context from its stored package. Retracted and expired records leave normal retrieval; `history(id)` still answers for them.
- **`retract` vs `forget`.** `retract(id, { expectedRevision, reason? })` keeps the history. `forget(id)` deletes the content, every revision and every vector, tombstones the id (a later create or revise of it conflicts), marks the receipts that wrote it `redacted`, writes its own content-free receipt and then awaits every `onForget` listener in order. `redaction` is `'complete'`, `'failed'` (a listener threw: logged, the forget stands; call `forget` again, which reruns the listeners with `alreadyForgotten: true` and `revisions: []` meaning every revision) or `'none'`. A forget never touches chats, the transcript index, host files or exported drafts.

## Extraction under the untrusted-source policy

`extract({ messages, kind?, ttlMs?, links?, topK?, supersede?, instructions?, infer? })` reads messages that carry their stable ids (`{ id, message, runId?, toolName? }[]`, e.g. `ChatRecord.messageIds`) and writes inferred records citing them. `CreateMemorySessionOptions.extraction` (`MemoryExtractionPolicy`) decides what it may read:

| Source | Read by default | Stored as |
| --- | --- | --- |
| User messages | yes | `user` |
| System (host) messages | yes | `host` |
| Results of tools named in `trustedTools` (name from `entry.toolName` or the matching tool call) | yes | `tool` |
| Other tool results (MCP, browser, web) | only with `allowExternal: true` | `external` |
| Assistant text | only with `allowAssistant: true` | `assistant` |
| Failed tool results; the SDK's own recall blocks, compaction summaries and tool-set notices | never | — |

Trust is declared by tool name in `extraction.trustedTools`; a tool has no trust flag of its own (no per-tool `memorySource: 'trusted'` mark), so the result of a tool that is not listed is `external` content, read only with `allowExternal`. One LLM call per operation, even across conflict retries. `infer: false` stores the readable sources verbatim; nothing readable still writes a durable empty receipt. The model can set neither scope, origin nor source kind.

## Stores, re-embedding, import and retention

- **SQL stores.** New tables (`deuz_vmem_*`) with their own `deuz_vmem_schema` version table; the legacy memory tables, `PRAGMA user_version` and the legacy migrate versions are untouched, so 2.3 still opens the file or schema. A `path` / `connectionString` connection is owned and closed by `close()`; a borrowed `database` / `pool` stays open. The PostgreSQL store needs a pool with `connect()` (a `query()`-only client is a `TypeError`); `migrate()` creates the tables up front and the first call does it otherwise. The SQLite FTS5 index runs with secure-delete (SQLite 3.42+), so forgotten text leaves the index pages; freed file pages and PostgreSQL dead tuples keep bytes until `VACUUM` (or `PRAGMA secure_delete`).
- **`reembed({ embedder, modelId, dims, batchSize = 64, concurrency = 1, signal? })`** fills a pending generation for the whole store (every scope) while search keeps the active one; records whose revision moved are embedded again. It returns `{ generation, embedded, skipped, activated }`; `activated: false` means records kept changing: call it again to resume. After activation the session embeds with the new embedder. One generation is prepared at a time: `embeddings.begin` (and so `reembed`) with another model or size retires the pending generation and deletes its vectors in the same transaction, and a `reembed` still filling it ends with `activated: false`. For an unknown or retired generation `pending` lists nothing, `put` stores nothing and returns `0`, and `activate` returns `false`; a generation an activation replaced never becomes active again. The in-memory, SQLite and PostgreSQL stores behave the same.
- **`importLegacyMemory({ from, to, scope, operationPrefix = 'import', batchSize = 64, origin = 'inferred' })`** writes one operation `<prefix>:<legacy id>` per record (legacy id kept, one host source, `metadata.legacyImport`), skips expired and invalidated records and carries no vectors over (re-embed afterwards). A re-run replays; a record changed since its import is skipped with a warning. Stop legacy writers on the scope first: there is no dual write. Returns `{ scanned, imported, skipped }`.
- **Retention is explicit.** `store.pruneHistory({ olderThan, scope? })` deletes past revisions of records that are currently retracted or expired (the current revision and receipts stay). `store.pruneOperations({ olderThan })` deletes old receipts and warns through the logger, because those operation ids lose their dedupe protection. Nothing is deleted in the background (`references/observability-retention.md`).

## Model tools, native runs and accounting

- `createVersionedMemoryTools(session)` returns an `AgentToolSet` for native runs (`runAgent({ tools })`, or `versionedMemory: { session, tools: true }` in a V3 run). Writes are inferred and cite `{ kind: 'assistant', toolCallId, toolName, chatId }`; the operation id comes from the execution scope, model step and tool call id, and the write tools are `replay: 'idempotent'`, so a replayed call applies once. `memory_recall` answers `{ id, revision, text, kind, origin, sourceKinds, status }`. `memory_revise` / `memory_retract` refuse asserted records (`{ error: 'asserted_record' }`) and return `{ error: 'revision_conflict', actualRevision }` or `{ error: 'not_found' }` as data the model can act on.
- **In a V3 run** (`references/v3-runs.md`) writes go through a durable intent → plan → commit → acknowledgment protocol recorded in `memoryIntents`, and `extract: true` extracts the completed run's turns. The context compiler reads a session as a memory source (`references/context-working-memory.md`).
- **Accounting.** With `execution` (a `NativeExecutionContext`), each memory LLM call (kind `'memory-llm'`, model `llmModelId`, default `'memory-llm'`) and embedding call (kind `'memory-embedding'`, model `embedderModelId`) is reserved before it runs, so a budget or policy can refuse it. A callback built with `defineAccountedMemoryLLM(fn)` (it returns `{ text, usage, modelId }`) or an embedder marked `accounted: true` settles its reported usage; an unmarked one stays held at its estimate as unaccounted (never free) and reports one `unaccounted-usage` warning per session. Under `unknownPrice: 'reject'` an unaccounted call is refused (`unaccounted_call`).
- **Spans.** Each operation reports `deuz.memory.op` through `deps.observer` (`deuz.memory.operation`, `record_count`, `conflict_retries`, `embedding_generation`): counts and ids only, never memory text.

## Deep dive

- [/docs/modules/versioned-memory](/docs/modules/versioned-memory) (2.4) — every option, reconciliation, extraction policy, stores and limits.
- [/docs/modules/retention](/docs/modules/retention) (2.4) — forget and V3 context packages, retention windows.
- [/docs/modules/memory](/docs/modules/memory) — the legacy seam, and what changed in it in 2.4.
