/**
 * Versioned memory contracts (2.4, spec §2.1–§2.2): records with a stable id,
 * increasing revisions, provenance and an `asserted | inferred` origin; writes
 * that commit the active record, its immutable revision, the search index and
 * an operation receipt in one transaction; idempotent replay by operation id;
 * forget that removes content and keeps a content-free receipt. The legacy
 * `MemoryStore` seam (`@deuz-sdk/core/memory`) is untouched: these are new
 * tables and a new interface beside it.
 *
 * Scopes: a record is addressed by its `MemoryScope` (`userId`, `agentId`,
 * `runId`, `actorId`, `chatId`), the memory address, never by the tenancy
 * `scope` string of runs and goals.
 */
import type { Sha256Digest } from '../../internal/digest';
import type { Embedder, MemoryKind, MemoryLLM, MemoryScope, MemoryStore } from '../../memory';
import type { AccountedMemoryEmbedder, AccountedMemoryLLM } from '../../types/accounting';
import type { Dependencies } from '../../types/deps';
import type { NativeExecutionContext } from '../../types/execution';
import type { Message } from '../../types/message';

// ===================================================================
// Records and provenance
// ===================================================================

/**
 * What kind of source a fact was read from. A link to a source shows where a
 * fact came from; it never proves the fact.
 */
export type MemorySourceKind = 'user' | 'assistant' | 'tool' | 'external' | 'host';

/**
 * How a record came to be: `'inferred'` for everything a model extracted or
 * wrote, `'asserted'` only through an explicit host call. A model can never
 * set or change it.
 */
export type MemoryOrigin = 'asserted' | 'inferred';

/** One source a record rests on: the run, message or tool result, and a digest of its content. */
export interface MemorySourceRef {
  kind: MemorySourceKind;
  /** The native run the source belongs to. */
  runId?: string;
  /** The chat the message belongs to; `resolveSource` resolves it under a scope check. */
  chatId?: string;
  /** The message's stable id (`ChatRecord.messageIds`). */
  messageId?: string;
  /** The tool call whose result it is. */
  toolCallId?: string;
  toolName?: string;
  /** An external source's location (a URL, an MCP resource URI). */
  uri?: string;
  /** `sha256:<hex>` of the source content as it was read. */
  digest: Sha256Digest;
}

/** A graph link from one record to another (by stable id). */
export interface MemoryLink {
  recordId: string;
  /** What the link means, e.g. `'supersedes'`, `'about'`. */
  relation?: string;
}

/**
 * The vector of one record revision. It belongs to that revision's exact text
 * (`textDigest`): a revised text never inherits the old vector.
 */
export interface MemoryEmbeddingMeta {
  /** The embedding generation (see `VersionedMemoryStore.embeddings`). */
  generation: number;
  modelId: string;
  dims: number;
  /** The revision the vector was computed for. */
  revision: number;
  /** `sha256:<hex>` of the text the vector was computed from. */
  textDigest: Sha256Digest;
}

/** Where a record stands in normal retrieval. A forgotten record no longer exists. */
export type VersionedMemoryStatus = 'active' | 'retracted';

/** One revision of a versioned memory record (2.4). Plain JSON. */
export interface VersionedMemoryRecord {
  /** Stable across every revision. */
  id: string;
  /** 1 for the first revision, plus one on every revise or retract. */
  revision: number;
  scope: MemoryScope;
  text: string;
  kind: MemoryKind;
  origin: MemoryOrigin;
  /** At least one; a model-written record cites the messages or tool results it used. */
  sources: MemorySourceRef[];
  status: VersionedMemoryStatus;
  /** 0..1, never blocks a write. */
  importance?: number;
  /** Epoch ms after which normal retrieval skips the record (TTL). History stays until pruned. */
  expiresAt?: number;
  links?: MemoryLink[];
  /** Host metadata, JSON. */
  metadata?: Record<string, unknown>;
  /** This revision's vector, when one was computed in the active generation. */
  embedding?: MemoryEmbeddingMeta;
  /** The operation that wrote this revision. */
  operationId: string;
  /** When the store recorded this revision, epoch ms on its clock (`recordedAsOf` reads it). */
  recordedAt: number;
  /** When the first revision was recorded. */
  createdAt: number;
  /** `sha256:<hex>` of this revision's canonical content (text, kind, origin, sources, links). */
  digest: Sha256Digest;
}

/** A record as a write creates it; the store assigns revision, times and digest. */
export interface VersionedMemoryRecordInput {
  /** A stable id; generated when absent. */
  id?: string;
  text: string;
  kind?: MemoryKind;
  origin: MemoryOrigin;
  sources: MemorySourceRef[];
  importance?: number;
  expiresAt?: number;
  links?: MemoryLink[];
  metadata?: Record<string, unknown>;
}

/** What a revise may change. Scope, origin and source kinds are never revisable by a model. */
export interface VersionedMemoryRevision {
  text?: string;
  kind?: MemoryKind;
  importance?: number;
  /** `null` removes the TTL. */
  expiresAt?: number | null;
  links?: MemoryLink[];
  metadata?: Record<string, unknown> | null;
  /** Sources of the new revision; defaults to the previous revision's. */
  sources?: MemorySourceRef[];
}

// ===================================================================
// Operations and receipts
// ===================================================================

/** One change inside an operation. */
export type VersionedMemoryMutation =
  | {
      type: 'create';
      record: VersionedMemoryRecordInput & { id: string };
      /** The vector of the final text, computed outside the transaction. */
      embedding?: VersionedMemoryVector;
    }
  | {
      type: 'revise';
      id: string;
      expectedRevision: number;
      changes: VersionedMemoryRevision;
      embedding?: VersionedMemoryVector;
    }
  | { type: 'retract'; id: string; expectedRevision: number; reason?: string };

/** A vector handed to a commit: it must match the active generation's model and size. */
export interface VersionedMemoryVector {
  vector: number[];
  modelId: string;
  /** `sha256:<hex>` of the exact text it was computed from. */
  textDigest: Sha256Digest;
}

/** Who issued an operation (recorded on its receipt). */
export type VersionedMemoryActor = 'host' | 'model' | 'extraction' | 'import';

/**
 * One atomic write (2.4). The store checks `expectedScopeRevision` (when set)
 * and every mutation's `expectedRevision`, then applies all mutations, their
 * revisions, the index entries and the receipt in one transaction, or nothing.
 * An empty operation, and one that only retracts, still writes its receipt.
 */
export interface VersionedMemoryCommit {
  /** The idempotency key: the same id with the same request replays the receipt. */
  operationId: string;
  scope: MemoryScope;
  /** The scope's revision the operation was planned against. */
  expectedScopeRevision?: number;
  actor: VersionedMemoryActor;
  mutations: VersionedMemoryMutation[];
  /**
   * Canonical-JSON `sha256:<hex>` of the request (operation id excluded): the
   * same id with another digest throws `OperationConflictError`.
   */
  requestDigest: Sha256Digest;
}

/** What one mutation produced. */
export interface VersionedMemoryReceiptEntry {
  type: VersionedMemoryMutation['type'];
  id: string;
  /** The revision the mutation wrote. */
  revision: number;
}

/**
 * The durable outcome of an operation (2.4). Kept after `forget`, without
 * content, so a redelivered operation cannot bring a forgotten record back.
 */
export interface VersionedMemoryReceipt {
  operationId: string;
  scope: MemoryScope;
  actor: VersionedMemoryActor;
  requestDigest: Sha256Digest;
  /** The scope's revision after the commit. */
  scopeRevision: number;
  entries: VersionedMemoryReceiptEntry[];
  committedAt: number;
  /** A record of the operation was forgotten since: its entries name no content any more. */
  redacted?: boolean;
}

/** The answer to a commit. */
export type VersionedMemoryCommitResult =
  /** Applied now. */
  | { status: 'committed'; receipt: VersionedMemoryReceipt }
  /** Applied before under the same operation id and request: nothing changed. */
  | { status: 'replayed'; receipt: VersionedMemoryReceipt }
  /**
   * An expected revision no longer holds: nothing was applied. The session
   * re-reads, reconciles and tries again (three attempts by default).
   */
  | {
      status: 'conflict';
      scopeRevision: number;
      conflicts: { id: string; expectedRevision: number; actualRevision?: number }[];
    };

// ===================================================================
// Queries
// ===================================================================

/** A retrieval query over the active (or, with `recordedAsOf`, the then-known) revisions. */
export interface VersionedMemoryQuery {
  scope: MemoryScope;
  text?: string;
  /** Must match the active generation's model and size, or the query throws `EmbeddingMismatchError`. */
  embedding?: { vector: number[]; modelId: string };
  kind?: MemoryKind;
  /** Default 5. */
  topK?: number;
  /**
   * The revisions the store knew at this time (epoch ms, store clock): what
   * the system believed then. The existing `asOf` validity query is separate
   * and unchanged in the legacy stores.
   */
  recordedAsOf?: number;
  /** Include retracted records (default false). */
  includeRetracted?: boolean;
  /** Include records whose TTL passed (default false). */
  includeExpired?: boolean;
  /** The time TTLs are judged at; defaults to the store's clock. */
  now?: number;
}

/** One retrieval hit. */
export interface VersionedMemoryHit {
  record: VersionedMemoryRecord;
  score: number;
  /** How it matched: by vector, by text, or both fused (RRF). */
  match: 'vector' | 'lexical' | 'hybrid';
}

/** An embedding generation (2.4): one model and size; exactly one is active per store. */
export interface MemoryEmbeddingGeneration {
  generation: number;
  modelId: string;
  dims: number;
  status: 'pending' | 'active' | 'retired';
  createdAt: number;
}

/** A current record revision that still lacks a vector in a generation. */
export interface MemoryReembedItem {
  id: string;
  revision: number;
  scope: MemoryScope;
  text: string;
  textDigest: Sha256Digest;
}

// ===================================================================
// Forget
// ===================================================================

/**
 * What a forget removed (2.4), handed to every `onForget` listener after the
 * memory store committed it. A V3 run store subscribes to redact the compiled
 * context packages that contain these revisions.
 */
export interface MemoryForgetEvent {
  scope: MemoryScope;
  recordId: string;
  /**
   * Every revision that existed, now deleted with its vectors. Empty with
   * `alreadyForgotten`: then it stands for every revision the record had.
   */
  revisions: number[];
  operationId: string;
  /**
   * The record had already been forgotten in this scope (a retried forget, or
   * a replayed operation id): nothing more was deleted. The session calls the
   * `onForget` listeners again, so a redaction that a crash between the
   * forget and its listeners cut short completes on the retry. Absent for a
   * record the scope never had.
   */
  alreadyForgotten?: true;
}

/** Called after a forget committed; awaited in order. A failure never undoes the forget. */
export type MemoryForgetListener = (event: MemoryForgetEvent) => void | Promise<unknown>;

/** What `forget` did. */
export interface MemoryForgetResult extends MemoryForgetEvent {
  /**
   * `'failed'` when a listener threw: call `forget` again (it reruns the
   * listeners with `alreadyForgotten`), or run the redaction from the event.
   */
  redaction: 'complete' | 'failed' | 'none';
}

// ===================================================================
// The store
// ===================================================================

/** Retention for `pruneHistory` (spec §4.4); an explicit call, never run in the background. */
export interface MemoryPruneHistoryOptions {
  /**
   * Delete past revisions of retracted or expired records recorded before
   * this time (epoch ms on the store clock; exclusive).
   */
  olderThan: number;
  /** Only this scope (matched exactly); every scope when absent. */
  scope?: MemoryScope;
}

/** Retention for `pruneOperations` (spec §4.4); an explicit call, never run in the background. */
export interface MemoryPruneOperationsOptions {
  /** Delete receipts committed before this time (epoch ms on the store clock; exclusive). */
  olderThan: number;
}

/**
 * Where versioned memory lives (2.4): in-memory here, SQLite at
 * `/memory/versioned/sqlite`, PostgreSQL at `/memory/versioned/postgres`.
 * New tables with their own schema version table; no legacy table changes.
 * Model calls never happen inside a store call.
 */
export interface VersionedMemoryStore {
  /**
   * Applies one operation atomically: expected revisions checked, every
   * mutation's new revision, the active record, the index entries (text and
   * vector) and the receipt written in one transaction, or nothing. A
   * repeated operation id with the same `requestDigest` returns `'replayed'`;
   * with another digest it throws `OperationConflictError`. A vector that
   * does not match the active generation throws `EmbeddingMismatchError`.
   * A mutation of a forgotten record conflicts (no actual revision); it is
   * never recreated.
   */
  commit(operation: VersionedMemoryCommit): Promise<VersionedMemoryCommitResult>;
  /** The current revision (or `revision`), retracted ones only with `includeRetracted`. */
  get(
    scope: MemoryScope,
    id: string,
    options?: { revision?: number; includeRetracted?: boolean },
  ): Promise<VersionedMemoryRecord | undefined>;
  /** Hybrid in SQLite and PostgreSQL (text + vector, RRF); simple matching in memory. */
  search(query: VersionedMemoryQuery): Promise<VersionedMemoryHit[]>;
  /** Every revision of a record, oldest first, retracted ones included. */
  history(scope: MemoryScope, id: string): Promise<VersionedMemoryRecord[]>;
  /** The receipt of an operation, also after its records were forgotten. */
  receipt(operationId: string): Promise<VersionedMemoryReceipt | undefined>;
  /** The scope's revision: plus one on every committed operation. 0 for an empty scope. */
  scopeRevision(scope: MemoryScope): Promise<number>;
  /**
   * Deletes a record's content, every revision and every vector, and redacts
   * its receipts' content; the operation ids stay, content-free. The forget
   * is an operation too: it leaves a content-free receipt and moves the scope
   * revision, a repeated id replays and another operation's id conflicts.
   * Returns the deleted revisions (none for an unknown record), and
   * `alreadyForgotten` when the scope's record was forgotten before.
   */
  forget(scope: MemoryScope, id: string, operationId: string): Promise<MemoryForgetEvent>;
  /**
   * Embedding generations for `reembed`: prepared aside, switched atomically.
   * One generation is prepared at a time. A retired generation (the one an
   * activation replaced, or a pending one another model or size replaced) is
   * done for good: it lists nothing, takes no vector and never becomes active
   * again. Every store behaves the same.
   */
  embeddings: {
    /** The active generation; absent before any vector was stored. */
    active(): Promise<MemoryEmbeddingGeneration | undefined>;
    /**
     * Returns the pending generation for this model and size, or starts one.
     * A pending generation of another model or size is retired and its
     * vectors deleted in the same transaction, so an abandoned job leaves no
     * vectors behind and a job still filling it loses quietly (`put` stores
     * nothing, `activate` returns false).
     */
    begin(request: { modelId: string; dims: number }): Promise<MemoryEmbeddingGeneration>;
    /**
     * Current revisions without a vector in `generation`, by id after
     * `after`; none for an unknown or retired generation.
     */
    pending(
      generation: number,
      options: { limit: number; after?: string },
    ): Promise<MemoryReembedItem[]>;
    /**
     * Stores vectors for the pending or the active generation; one whose
     * revision or text digest is no longer current is skipped. Returns how
     * many were stored: 0, storing nothing, for an unknown or retired
     * generation.
     */
    put(
      generation: number,
      vectors: { id: string; revision: number; textDigest: Sha256Digest; vector: number[] }[],
    ): Promise<number>;
    /**
     * Makes `generation` active once every current revision has its vector
     * there, retiring the active one and deleting its vectors; true when it
     * is active already. Returns false (and changes nothing) while some
     * revision still lacks one, and for an unknown or retired generation.
     */
    activate(generation: number): Promise<boolean>;
  };
  /**
   * Deletes the past revisions (and their vectors) of records whose current
   * revision is retracted or expired. The current revision, every receipt
   * (content-free, so dedupe holds) and forgotten ids stay. Returns how many
   * revisions it deleted.
   */
  pruneHistory(options: MemoryPruneHistoryOptions): Promise<number>;
  /**
   * Deletes old receipts. This removes the dedupe protection for those
   * operation ids (a redelivery is applied again): it warns through the
   * logger, with `{ count, olderThan }`. A forgotten id stays forgotten: its
   * tombstone is not a receipt. Returns how many receipts it deleted.
   */
  pruneOperations(options: MemoryPruneOperationsOptions): Promise<number>;
  /** Releases a connection the store opened itself; a borrowed one stays open. */
  close?(): Promise<void>;
}

// ===================================================================
// The session
// ===================================================================

/**
 * Which sources automatic extraction may read (2.4): by default only user
 * messages, host input and the results of the tools named in
 * `trustedTools`. External content (MCP, browser, web) and the results of
 * every other tool only with `allowExternal`, and then stored with source
 * kind `'external'`.
 */
export interface MemoryExtractionPolicy {
  /**
   * The names of the tools whose results count as trusted (source kind
   * `'tool'`), matched against each result's tool name. This list is the
   * only trust mark: a tool definition carries no trust flag of its own
   * (spec §2.1's per-tool `memorySource: 'trusted'` is declared here, by
   * name, instead).
   */
  trustedTools?: readonly string[];
  /** Read external content and the results of tools not in `trustedTools` too. Default false. */
  allowExternal?: boolean;
  /** Read assistant turns too. Default false. */
  allowAssistant?: boolean;
}

/** Per-call options of a session write. */
export interface MemoryWriteOptions {
  /** The idempotency key; generated when absent (then a retry is a new operation). */
  operationId?: string;
  signal?: AbortSignal;
}

/** What a session write did. */
export interface MemoryOperationResult {
  receipt: VersionedMemoryReceipt;
  /** True when the operation id was applied before with this request. */
  replayed: boolean;
  /** The records as written (current revisions). */
  records: VersionedMemoryRecord[];
  /** Commits that hit a revision conflict and were reconciled again. */
  conflictRetries: number;
}

/** A host's explicit `remember`. Only a host call may assert. */
export interface MemoryRememberInput {
  text: string;
  /** Default `'asserted'` for a host call; a model tool always writes `'inferred'`. */
  origin?: MemoryOrigin;
  kind?: MemoryKind;
  /** Default: one `'host'` source with the digest of `text`. */
  sources?: MemorySourceRef[];
  importance?: number;
  /** TTL in ms from now. */
  ttlMs?: number;
  links?: MemoryLink[];
  metadata?: Record<string, unknown>;
  /** Supersede policy: reconcile with similar records (LLM) or always add. Default `'reconcile'`. */
  supersede?: 'reconcile' | 'add';
}

/**
 * Automatic extraction in the session flow (2.4): the same options as a
 * manual remember (TTL, kind, links, retrieval breadth, supersede policy,
 * custom instructions), from messages that carry their stable ids.
 */
export interface MemoryExtractionInput {
  messages: readonly { id: string; message: Message; runId?: string; toolName?: string }[];
  kind?: MemoryKind;
  ttlMs?: number;
  links?: MemoryLink[];
  /** How many existing records reconciliation considers. Default 5. */
  topK?: number;
  supersede?: 'reconcile' | 'add';
  /** Extra extraction instructions for the memory LLM. */
  instructions?: string;
  /** Infer facts with the LLM (default true); false stores the source text verbatim. */
  infer?: boolean;
}

/** A recall through the session (its scope is fixed). */
export interface MemoryRecallInput {
  text?: string;
  kind?: MemoryKind;
  topK?: number;
  recordedAsOf?: number;
  includeRetracted?: boolean;
  signal?: AbortSignal;
}

/** Options of a re-embed job: resumable, batch 64, one batch at a time by default. */
export interface MemoryReembedOptions {
  /** The embedder of the new generation. */
  embedder: Embedder | AccountedMemoryEmbedder;
  /** Its model id and size: the generation's identity. */
  modelId: string;
  dims: number;
  /** Default 64. */
  batchSize?: number;
  /** Default 1. */
  concurrency?: number;
  signal?: AbortSignal;
}

/** Where a re-embed job stands; call `reembed` again to continue an interrupted one. */
export interface MemoryReembedResult {
  generation: number;
  /** Vectors stored by this call. */
  embedded: number;
  /** Items skipped because their revision moved meanwhile (embedded again later). */
  skipped: number;
  /** True once the generation became active. */
  activated: boolean;
}

/**
 * A memory session (2.4): one scope, one store. Every write goes through an
 * operation with a receipt; a conflict is re-read and reconciled up to
 * `maxConflictRetries` times, then throws `RevisionConflictError`. Model
 * calls (reconcile, embed) happen outside the store transaction, on the
 * final text.
 */
export interface MemorySession {
  readonly scope: MemoryScope;
  remember(
    input: MemoryRememberInput,
    options?: MemoryWriteOptions,
  ): Promise<MemoryOperationResult>;
  /** Extraction under the session's `MemoryExtractionPolicy`; writes are `'inferred'`. */
  extract(
    input: MemoryExtractionInput,
    options?: MemoryWriteOptions,
  ): Promise<MemoryOperationResult>;
  recall(input: MemoryRecallInput): Promise<VersionedMemoryHit[]>;
  /** A new revision; current search uses the new content (its old vector is not carried over). */
  revise(
    id: string,
    changes: VersionedMemoryRevision,
    options: MemoryWriteOptions & { expectedRevision: number },
  ): Promise<MemoryOperationResult>;
  /** Out of normal retrieval; history still answers for it. */
  retract(
    id: string,
    options: MemoryWriteOptions & { expectedRevision: number; reason?: string },
  ): Promise<MemoryOperationResult>;
  /**
   * Deletes the record's content, revisions and vectors, keeps the operation
   * ids content-free, then calls every `onForget` listener (V3 run stores
   * redact their context packages). A retry of a forget whose listeners did
   * not all run (a crash, a failed listener) calls them again with
   * `alreadyForgotten`. Never touches chats, the transcript index, host files
   * or exported drafts.
   */
  forget(id: string, options?: MemoryWriteOptions): Promise<MemoryForgetResult>;
  history(id: string): Promise<VersionedMemoryRecord[]>;
  /** A resumable re-embed into a new generation, switched atomically when complete. */
  reembed(options: MemoryReembedOptions): Promise<MemoryReembedResult>;
}

/** Options of `createMemorySession`. */
export interface CreateMemorySessionOptions {
  store: VersionedMemoryStore;
  scope: MemoryScope;
  /** Embeds final texts; without one, records are found by text only. */
  embedder?: Embedder | AccountedMemoryEmbedder;
  /** Reconciliation and extraction; required for `supersede: 'reconcile'` and `infer`. */
  llm?: MemoryLLM | AccountedMemoryLLM;
  /** Commit attempts on a revision conflict, the first included. Default 3. */
  maxConflictRetries?: number;
  extraction?: MemoryExtractionPolicy;
  onForget?: MemoryForgetListener | readonly MemoryForgetListener[];
  /** Charges embeddings and LLM calls to this context's ledger (accounted or unaccounted). */
  execution?: NativeExecutionContext;
  /**
   * The memory LLM's model id, named on its ledger reservations so prices and
   * `allowedModels` apply to it (2.4). Default `'memory-llm'`.
   */
  llmModelId?: string;
  /**
   * The embedder's model id for ledger reservations before any generation
   * names one (2.4). Default: the active generation's model, else
   * `'memory-embedder'`.
   */
  embedderModelId?: string;
  /** Clock, ids, logger, observer (`deuz.memory.op` spans). */
  deps?: Dependencies;
}

/** Options of `createVersionedMemoryTools`. */
export interface VersionedMemoryToolsOptions {
  /** Which tools to offer. Default: remember, recall, revise, retract (never forget). */
  include?: readonly ('remember' | 'recall' | 'revise' | 'retract')[];
  /** Tool name prefix. Default `'memory'`. */
  prefix?: string;
}

// ===================================================================
// Import from legacy memory
// ===================================================================

/**
 * An explicit, re-runnable import from any legacy `MemoryStore` (the SQLite
 * and PostgreSQL `deuz_memory` tables included) into a versioned store (2.4).
 * The current snapshot becomes revision 1; no history is invented. Stop the
 * legacy writers first: there is no dual write.
 */
export interface ImportLegacyMemoryOptions {
  from: MemoryStore;
  to: VersionedMemoryStore;
  scope: MemoryScope;
  /** Operation ids are `<prefix>:<legacy id>`, so a re-run replays. Default `'import'`. */
  operationPrefix?: string;
  /** Records per page. Default 64. */
  batchSize?: number;
  /** Origin given to imported records. Default `'inferred'`. */
  origin?: MemoryOrigin;
  signal?: AbortSignal;
  deps?: Dependencies;
}

/** What an import did. */
export interface ImportLegacyMemoryResult {
  scanned: number;
  imported: number;
  /** Already imported (replayed) or not importable (expired, superseded). */
  skipped: number;
}
