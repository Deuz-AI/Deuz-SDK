/**
 * `@deuz-sdk/core/memory/versioned/sqlite` (2.4): the versioned memory store
 * on `node:sqlite`. New tables (records, revisions, receipts, FTS5 index,
 * vectors per embedding generation) with their own `deuz_vmem_schema` version
 * table; the legacy `deuz_memory` table and `PRAGMA user_version` are never
 * touched. Every commit is one `BEGIN IMMEDIATE` transaction; search is hybrid
 * (FTS5 + vector, RRF), with a LIKE fallback where FTS5 is missing. Node-only.
 *
 * A commit reads what it touches, plans (digests are async WebCrypto, so they
 * are computed before the transaction), then applies the plan in one
 * synchronous transaction that first checks nothing it read has moved; a
 * writer in another process that got there first sends it round again. One
 * store serializes its own writes, so that only happens across processes.
 *
 * FTS5 is optional per process (Node 22.14's SQLite ships without it): a
 * process without it marks the index stale on every write, and the next
 * process with FTS5 rebuilds it before using it. The index runs with FTS5
 * `secure-delete`, so the tokens of a forgotten or pruned revision leave its
 * pages at once. Forget is still a logical delete for the file as a whole:
 * pages SQLite frees keep their bytes unless the host sets
 * `PRAGMA secure_delete` or runs `VACUUM`.
 */
import type {
  MemoryEmbeddingGeneration,
  MemoryForgetEvent,
  MemoryReembedItem,
  VersionedMemoryCommit,
  VersionedMemoryCommitResult,
  VersionedMemoryHit,
  VersionedMemoryQuery,
  VersionedMemoryReceipt,
  VersionedMemoryRecord,
  VersionedMemoryStore,
} from '../memory/versioned/types';
import type { Clock, Logger } from '../types/deps';
import type { Observer } from '../types/observe';
import type { Sha256Digest } from '../internal/digest';
import { InvalidRequestError } from '../errors';
import { decodeVector, encodeVector } from '../internal/vector';
import type { SqliteConnectionOptions } from './store-connection';
import type { SqliteDatabaseLike } from './store-sqlite';
import {
  createSqliteConnection,
  createSqliteStatementCache,
  ensureSqliteSchema,
  sqliteTransaction,
  sqliteUnavailableMessage,
  type SqliteStatementCache,
} from './sqlite-handle';
import {
  DEFAULT_TOP_K,
  FUSION_WINDOW,
  HOST_CLOCK,
  SILENT_LOGGER,
  VMEM_SCHEMA_NAME,
  VMEM_SCHEMA_VERSION,
  assertGenerationVector,
  assertQueryVector,
  commitIds,
  decodeReceipt,
  decodeRecord,
  embeddingMeta,
  encodeReceipt,
  encodeRecord,
  forgetReceipt,
  forgetRequestDigest,
  fuseHits,
  normalizeScope,
  planCommit,
  pruneOperationsWarning,
  queryTokens,
  rankByCosine,
  refuseForeignForget,
  replayOrRefuse,
  retentionSpan,
  scopeKey,
  snapshotFingerprint,
  validateCommit,
  validateGeneration,
  type CommitPlan,
  type CommitSnapshot,
  type ForgetOutcome,
  type RecordLookup,
  type ScoredRevision,
} from './vmem-shared';

/** Options of `createSqliteVersionedMemoryStore`. */
export type SqliteVersionedMemoryStoreOptions = SqliteConnectionOptions & {
  /** Build the FTS5 index. Default true, with a LIKE fallback. */
  fts?: boolean;
  /** The store clock (`recordedAt`, TTL). Default: the host clock. */
  clock?: Clock;
  /** Where `pruneOperations` warns that it gave up dedupe protection. Default: silent. */
  logger?: Logger;
  /** Reports `deuz.memory.op` spans for `pruneHistory` and `pruneOperations`. */
  observer?: Observer;
};

/** A SQLite `VersionedMemoryStore`; `close()` closes only a connection it opened. */
export type SqliteVersionedMemoryStore = VersionedMemoryStore & { close(): Promise<void> };

type SqlValue = string | number | null | Uint8Array;

/** Attempts of a commit against writers in other processes. */
const COMMIT_ATTEMPTS = 5;
/** Vectors a query scores at most: the freshest candidates of the scope. */
const VECTOR_SCAN_MIN = 1000;

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS deuz_vmem_records (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_vmem_records_scope_idx ON deuz_vmem_records (scope_key, id)',
  `CREATE TABLE IF NOT EXISTS deuz_vmem_revisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    scope_key TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    text_digest TEXT NOT NULL,
    expires_at INTEGER,
    recorded_at INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    record TEXT NOT NULL,
    UNIQUE (id, revision)
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_vmem_revisions_scope_idx ON deuz_vmem_revisions (scope_key, recorded_at)',
  'CREATE TABLE IF NOT EXISTS deuz_vmem_scopes (scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS deuz_vmem_receipts (
    operation_id TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    redacted INTEGER NOT NULL DEFAULT 0,
    receipt TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_vmem_receipts_time_idx ON deuz_vmem_receipts (committed_at)',
  `CREATE TABLE IF NOT EXISTS deuz_vmem_receipt_records (
    record_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    PRIMARY KEY (record_id, operation_id)
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_vmem_receipt_records_op_idx ON deuz_vmem_receipt_records (operation_id)',
  `CREATE TABLE IF NOT EXISTS deuz_vmem_forgotten (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    forgotten_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deuz_vmem_generations (
    generation INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    dims INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deuz_vmem_vectors (
    generation INTEGER NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    text_digest TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (generation, id, revision)
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_vmem_vectors_record_idx ON deuz_vmem_vectors (id, revision)',
  'CREATE TABLE IF NOT EXISTS deuz_vmem_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

const FTS_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS deuz_vmem_fts
  USING fts5(text, content='deuz_vmem_revisions', content_rowid='seq')`;

interface State {
  db: SqliteDatabaseLike;
  statement: SqliteStatementCache;
  /** Lexical search runs on FTS5; false means LIKE. */
  fts: boolean;
}

function all(s: State, sql: string, params: SqlValue[] = []): Record<string, unknown>[] {
  return s.statement(s.db, sql).all(...params) as Record<string, unknown>[];
}

function one(s: State, sql: string, params: SqlValue[] = []): Record<string, unknown> | undefined {
  return s.statement(s.db, sql).get(...params) as Record<string, unknown> | undefined;
}

function run(s: State, sql: string, params: SqlValue[] = []): number {
  const result = s.statement(s.db, sql).run(...params) as { changes?: number | bigint } | undefined;
  return Number(result?.changes ?? 0);
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function bytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0);
}

function toGeneration(row: Record<string, unknown>): MemoryEmbeddingGeneration {
  return {
    generation: num(row.generation),
    modelId: text(row.model_id),
    dims: num(row.dims),
    status: text(row.status) as MemoryEmbeddingGeneration['status'],
    createdAt: num(row.created_at),
  };
}

// --- the FTS index -------------------------------------------------------

const FTS_DIRTY = 'fts_dirty';

/**
 * Turns on FTS5 `secure-delete` (persistent, SQLite 3.42+): a revision that
 * forget or pruneHistory deletes leaves the index pages themselves, instead of
 * staying behind a delete marker until a segment merge that a small store may
 * never run. An older SQLite keeps the default; its tokens go at the next merge.
 */
function secureDelete(s: State): void {
  try {
    const row = one(s, "SELECT v FROM deuz_vmem_fts_config WHERE k = 'secure-delete'");
    if (row && num(row.v) === 1) return;
    s.db.exec("INSERT INTO deuz_vmem_fts(deuz_vmem_fts, rank) VALUES('secure-delete', 1)");
  } catch {
    // SQLite before 3.42 does not know the option: lexical search works the same.
  }
}

/** Builds the index in its own transaction; false when this SQLite has no FTS5. */
function setupFts(s: State): boolean {
  try {
    const existed = one(
      s,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deuz_vmem_fts'",
    );
    sqliteTransaction(s.db, () => {
      s.db.exec(FTS_TABLE);
      if (!existed) s.db.exec("INSERT INTO deuz_vmem_fts(deuz_vmem_fts) VALUES('rebuild')");
    });
    secureDelete(s);
    all(s, 'SELECT rowid FROM deuz_vmem_fts WHERE deuz_vmem_fts MATCH ? LIMIT 1', ['"deuz"']);
    s.fts = true;
    syncFts(s, false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuilds the index when a process without FTS5 wrote since: before a
 * lexical query, and inside every write transaction before it touches the
 * index (a delete for a row the index never saw would corrupt it).
 */
function syncFts(s: State, inTransaction: boolean): void {
  if (!s.fts) return;
  if (!one(s, 'SELECT value FROM deuz_vmem_state WHERE key = ?', [FTS_DIRTY])) return;
  const rebuild = () => {
    s.db.exec("INSERT INTO deuz_vmem_fts(deuz_vmem_fts) VALUES('rebuild')");
    run(s, 'DELETE FROM deuz_vmem_state WHERE key = ?', [FTS_DIRTY]);
  };
  if (inTransaction) rebuild();
  else sqliteTransaction(s.db, rebuild);
}

function indexRevision(s: State, seq: number, body: string): void {
  if (s.fts) run(s, 'INSERT INTO deuz_vmem_fts(rowid, text) VALUES (?, ?)', [seq, body]);
}

function unindexRevision(s: State, seq: number, body: string): void {
  if (s.fts)
    run(s, "INSERT INTO deuz_vmem_fts(deuz_vmem_fts, rowid, text) VALUES('delete', ?, ?)", [
      seq,
      body,
    ]);
}

/** After a write without FTS5: the next process with it rebuilds the index. */
function markWritten(s: State): void {
  if (!s.fts)
    run(s, 'INSERT OR REPLACE INTO deuz_vmem_state (key, value) VALUES (?, ?)', [FTS_DIRTY, '1']);
}

// --- reads ----------------------------------------------------------------

function readActive(s: State): MemoryEmbeddingGeneration | undefined {
  const row = one(s, "SELECT * FROM deuz_vmem_generations WHERE status = 'active'");
  return row ? toGeneration(row) : undefined;
}

function readGeneration(s: State, generation: number): MemoryEmbeddingGeneration | undefined {
  const row = one(s, 'SELECT * FROM deuz_vmem_generations WHERE generation = ?', [generation]);
  return row ? toGeneration(row) : undefined;
}

function readReceipt(s: State, operationId: string): VersionedMemoryReceipt | undefined {
  const row = one(s, 'SELECT receipt, redacted FROM deuz_vmem_receipts WHERE operation_id = ?', [
    operationId,
  ]);
  return row ? decodeReceipt(text(row.receipt), num(row.redacted) === 1) : undefined;
}

/** Whether record `id` was forgotten while scope `key` owned it. */
function forgottenIn(s: State, id: string, key: string): boolean {
  const row = one(s, 'SELECT scope_key FROM deuz_vmem_forgotten WHERE id = ?', [id]);
  return row !== undefined && text(row.scope_key) === key;
}

function readScopeRevision(s: State, key: string): number {
  const row = one(s, 'SELECT revision FROM deuz_vmem_scopes WHERE scope_key = ?', [key]);
  return row ? num(row.revision) : 0;
}

function readSnapshot(s: State, key: string, ids: readonly string[]): CommitSnapshot {
  const records = new Map<string, RecordLookup>();
  for (const id of ids) {
    const live = one(
      s,
      'SELECT c.scope_key, r.record FROM deuz_vmem_records c ' +
        'JOIN deuz_vmem_revisions r ON r.id = c.id AND r.revision = c.revision WHERE c.id = ?',
      [id],
    );
    if (live) {
      records.set(id, {
        state: 'live',
        scopeKey: text(live.scope_key),
        current: decodeRecord(text(live.record)),
      });
      continue;
    }
    const forgotten = one(s, 'SELECT scope_key FROM deuz_vmem_forgotten WHERE id = ?', [id]);
    if (forgotten) records.set(id, { state: 'forgotten', scopeKey: text(forgotten.scope_key) });
  }
  return { scopeRevision: readScopeRevision(s, key), records, active: readActive(s) };
}

/** The record with its embedding in the active generation, when it has one there. */
function withEmbedding(
  s: State,
  record: VersionedMemoryRecord,
  active: MemoryEmbeddingGeneration | undefined,
): VersionedMemoryRecord {
  if (!active) return record;
  const row = one(
    s,
    'SELECT text_digest FROM deuz_vmem_vectors WHERE generation = ? AND id = ? AND revision = ?',
    [active.generation, record.id, record.revision],
  );
  return row
    ? {
        ...record,
        embedding: embeddingMeta(active, record.revision, text(row.text_digest) as Sha256Digest),
      }
    : record;
}

// --- writes ---------------------------------------------------------------

function applyPlan(
  s: State,
  plan: Extract<CommitPlan, { kind: 'apply' }>,
  active?: MemoryEmbeddingGeneration,
): void {
  syncFts(s, true);
  let generation = active?.generation;
  if (plan.generation) {
    const row = one(
      s,
      "INSERT INTO deuz_vmem_generations (model_id, dims, status, created_at) VALUES (?, ?, 'active', ?) RETURNING generation",
      [plan.generation.modelId, plan.generation.dims, plan.receipt.committedAt],
    );
    generation = num(row!.generation);
  }
  plan.revisions.forEach((record, index) => {
    const inserted = one(
      s,
      'INSERT INTO deuz_vmem_revisions (id, revision, scope_key, status, kind, text, text_digest, ' +
        'expires_at, recorded_at, operation_id, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq',
      [
        record.id,
        record.revision,
        plan.scopeKey,
        record.status,
        record.kind,
        record.text,
        plan.textDigests[index]!,
        record.expiresAt ?? null,
        record.recordedAt,
        record.operationId,
        encodeRecord(record),
      ],
    );
    indexRevision(s, num(inserted!.seq), record.text);
    run(
      s,
      'INSERT INTO deuz_vmem_records (id, scope_key, revision, created_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET revision = excluded.revision',
      [record.id, plan.scopeKey, record.revision, record.createdAt],
    );
  });
  for (const carry of plan.carried)
    run(
      s,
      'INSERT OR IGNORE INTO deuz_vmem_vectors (generation, id, revision, text_digest, vector) ' +
        'SELECT generation, id, ?, text_digest, vector FROM deuz_vmem_vectors ' +
        'WHERE id = ? AND revision = ? AND text_digest = ?',
      [carry.toRevision, carry.id, carry.fromRevision, carry.textDigest],
    );
  for (const vector of plan.vectors)
    run(
      s,
      'INSERT OR REPLACE INTO deuz_vmem_vectors (generation, id, revision, text_digest, vector) VALUES (?, ?, ?, ?, ?)',
      [generation!, vector.id, vector.revision, vector.textDigest, encodeVector(vector.vector)],
    );
  for (const id of new Set(plan.receipt.entries.map((entry) => entry.id)))
    run(
      s,
      'INSERT OR IGNORE INTO deuz_vmem_receipt_records (record_id, operation_id) VALUES (?, ?)',
      [id, plan.receipt.operationId],
    );
  run(
    s,
    'INSERT INTO deuz_vmem_scopes (scope_key, revision) VALUES (?, ?) ' +
      'ON CONFLICT(scope_key) DO UPDATE SET revision = excluded.revision',
    [plan.scopeKey, plan.receipt.scopeRevision],
  );
  run(
    s,
    'INSERT INTO deuz_vmem_receipts (operation_id, request_digest, committed_at, redacted, receipt) VALUES (?, ?, ?, 0, ?)',
    [
      plan.receipt.operationId,
      plan.receipt.requestDigest,
      plan.receipt.committedAt,
      encodeReceipt(plan.receipt),
    ],
  );
  markWritten(s);
}

// --- search ---------------------------------------------------------------

/** The candidate revisions of a query: the scope, then the time, status, kind and TTL filters. */
interface Candidates {
  joins: string;
  where: string;
  params: SqlValue[];
}

function candidates(key: string, query: VersionedMemoryQuery, now: number): Candidates {
  const params: SqlValue[] = [key];
  let joins = '';
  let where = 'r.scope_key = ?';
  if (query.recordedAsOf === undefined) {
    joins = 'JOIN deuz_vmem_records c ON c.id = r.id AND c.revision = r.revision';
  } else {
    where +=
      ' AND r.recorded_at <= ? AND r.revision = (SELECT MAX(h.revision) FROM deuz_vmem_revisions h ' +
      'WHERE h.id = r.id AND h.recorded_at <= ?)';
    params.push(query.recordedAsOf, query.recordedAsOf);
  }
  if (!query.includeRetracted) where += " AND r.status = 'active'";
  if (query.kind !== undefined) {
    where += ' AND r.kind = ?';
    params.push(query.kind);
  }
  if (!query.includeExpired) {
    where += ' AND (r.expires_at IS NULL OR r.expires_at > ?)';
    params.push(now);
  }
  return { joins, where, params };
}

function lexicalSearch(s: State, c: Candidates, tokens: string[], take: number): ScoredRevision[] {
  if (tokens.length === 0) return [];
  syncFts(s, false);
  if (s.fts) {
    try {
      const rows = all(
        s,
        `SELECT r.record, bm25(deuz_vmem_fts) AS lexical_rank FROM deuz_vmem_fts ` +
          `JOIN deuz_vmem_revisions r ON r.seq = deuz_vmem_fts.rowid ${c.joins} ` +
          `WHERE deuz_vmem_fts MATCH ? AND ${c.where} ORDER BY lexical_rank, r.recorded_at DESC, r.id LIMIT ?`,
        [tokens.map((t) => `"${t}"`).join(' OR '), ...c.params, take],
      );
      // bm25 is negative (better = more negative): flip and normalize against the best hit.
      const raw = rows.map((row) => ({
        record: decodeRecord(text(row.record)),
        score: -num(row.lexical_rank),
      }));
      const best = raw[0]?.score ?? 0;
      return raw.map((hit) => ({ record: hit.record, score: best > 0 ? hit.score / best : 1 }));
    } catch {
      // A query the index will not parse is answered by LIKE, never by an error.
    }
  }
  const like = tokens.map(() => "r.text LIKE ? ESCAPE '\\'");
  const patterns = tokens.map((t) => `%${t}%`);
  const rows = all(
    s,
    `SELECT r.record, (${like.map((l) => `(CASE WHEN ${l} THEN 1 ELSE 0 END)`).join(' + ')}) AS hits ` +
      `FROM deuz_vmem_revisions r ${c.joins} WHERE (${like.join(' OR ')}) AND ${c.where} ` +
      'ORDER BY hits DESC, r.recorded_at DESC, r.id LIMIT ?',
    [...patterns, ...patterns, ...c.params, take],
  );
  return rows.map((row) => ({
    record: decodeRecord(text(row.record)),
    score: num(row.hits) / tokens.length,
  }));
}

function vectorSearch(
  s: State,
  c: Candidates,
  active: MemoryEmbeddingGeneration,
  vector: number[],
  take: number,
): ScoredRevision[] {
  const rows = all(
    s,
    'SELECT r.record, v.vector, v.text_digest FROM deuz_vmem_vectors v ' +
      `JOIN deuz_vmem_revisions r ON r.id = v.id AND r.revision = v.revision ${c.joins} ` +
      `WHERE v.generation = ? AND ${c.where} ORDER BY r.recorded_at DESC, r.id LIMIT ?`,
    [active.generation, ...c.params, Math.max(VECTOR_SCAN_MIN, take * 50)],
  );
  return rankByCosine(
    rows.map((row) => {
      const record = decodeRecord(text(row.record));
      return {
        record: {
          ...record,
          embedding: embeddingMeta(active, record.revision, text(row.text_digest) as Sha256Digest),
        },
        vector: decodeVector(bytes(row.vector)),
      };
    }),
    vector,
    take,
  );
}

function listing(s: State, c: Candidates, take: number): VersionedMemoryHit[] {
  return all(
    s,
    `SELECT r.record FROM deuz_vmem_revisions r ${c.joins} WHERE ${c.where} ` +
      'ORDER BY r.recorded_at DESC, r.id LIMIT ?',
    [...c.params, take],
  ).map((row) => ({ record: decodeRecord(text(row.record)), score: 0, match: 'lexical' as const }));
}

// --- the factory ----------------------------------------------------------

/** The SQLite versioned memory store (2.4). */
export function createSqliteVersionedMemoryStore(
  options: SqliteVersionedMemoryStoreOptions,
): SqliteVersionedMemoryStore {
  const clock = options.clock ?? HOST_CLOCK;
  const logger = options.logger ?? SILENT_LOGGER;
  const connection = createSqliteConnection<State>(
    options.database
      ? { path: ':memory:', database: options.database, wal: false }
      : { path: options.path, wal: options.wal },
    {
      injected: 'borrowed',
      unavailable: sqliteUnavailableMessage('createSqliteVersionedMemoryStore'),
      closedMessage: 'The SQLite versioned memory store is closed',
      setup(db) {
        ensureSqliteSchema(db, {
          name: VMEM_SCHEMA_NAME,
          version: VMEM_SCHEMA_VERSION,
          create: SCHEMA,
        });
        const state: State = { db, statement: createSqliteStatementCache(), fts: false };
        if (options.fts !== false) setupFts(state);
        return state;
      },
    },
  );

  // One writer at a time per store: a write's async planning never races its own siblings.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  const write = <T>(fn: (s: State) => T | Promise<T>): Promise<T> =>
    serialize(() => connection.use((s) => fn(s)) as Promise<T>);

  async function commit(op: VersionedMemoryCommit): Promise<VersionedMemoryCommitResult> {
    validateCommit(op);
    const key = scopeKey(op.scope);
    const ids = commitIds(op);
    return write(async (s) => {
      for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
        const stored = readReceipt(s, op.operationId);
        if (stored) return replayOrRefuse(op, stored);
        const snapshot = readSnapshot(s, key, ids);
        const plan = await planCommit(snapshot, op, clock.now());
        if (plan.kind === 'conflict') return plan.result;
        const fingerprint = snapshotFingerprint(snapshot, ids);
        const applied = sqliteTransaction(s.db, () => {
          if (readReceipt(s, op.operationId)) return false;
          const now = readSnapshot(s, key, ids);
          if (snapshotFingerprint(now, ids) !== fingerprint) return false;
          applyPlan(s, plan, now.active);
          return true;
        });
        if (applied) return { status: 'committed' as const, receipt: plan.receipt };
      }
      throw new Error(
        `Versioned memory operation '${op.operationId}' kept losing to concurrent writers ` +
          `(${COMMIT_ATTEMPTS} attempts); try again.`,
      );
    });
  }

  const store: SqliteVersionedMemoryStore = {
    commit,

    get(scope, id, getOptions = {}) {
      const key = scopeKey(scope);
      return connection.use((s) => {
        const row = one(
          s,
          'SELECT r.record, r.status FROM deuz_vmem_records c JOIN deuz_vmem_revisions r ' +
            'ON r.id = c.id AND r.revision = COALESCE(?, c.revision) WHERE c.id = ? AND c.scope_key = ?',
          [getOptions.revision ?? null, id, key],
        );
        if (!row) return undefined;
        if (text(row.status) === 'retracted' && !getOptions.includeRetracted) return undefined;
        return withEmbedding(s, decodeRecord(text(row.record)), readActive(s));
      });
    },

    search(query) {
      const key = scopeKey(query.scope);
      return connection.use((s) => {
        const topK = query.topK ?? DEFAULT_TOP_K;
        const active = readActive(s);
        const byVector = assertQueryVector(active, query.embedding);
        const byText = query.text !== undefined && query.text.trim() !== '';
        const c = candidates(key, query, query.now ?? clock.now());
        if (!byVector && !byText) return query.embedding ? [] : listing(s, c, topK);
        const take = byVector && byText ? Math.max(topK, FUSION_WINDOW) : topK;
        const lexical = byText ? lexicalSearch(s, c, queryTokens(query.text), take) : undefined;
        const vector = byVector
          ? vectorSearch(s, c, active!, query.embedding!.vector, take)
          : undefined;
        return fuseHits(lexical, vector, topK).map((hit) =>
          hit.record.embedding ? hit : { ...hit, record: withEmbedding(s, hit.record, active) },
        );
      });
    },

    history(scope, id) {
      const key = scopeKey(scope);
      return connection.use((s) => {
        const active = readActive(s);
        return all(
          s,
          'SELECT record FROM deuz_vmem_revisions WHERE id = ? AND scope_key = ? ORDER BY revision',
          [id, key],
        ).map((row) => withEmbedding(s, decodeRecord(text(row.record)), active));
      });
    },

    receipt(operationId) {
      return connection.use((s) => readReceipt(s, operationId));
    },

    scopeRevision(scope) {
      const key = scopeKey(scope);
      return connection.use((s) => readScopeRevision(s, key));
    },

    async forget(scope, id, operationId): Promise<MemoryForgetEvent> {
      const normalized = normalizeScope(scope);
      const key = scopeKey(normalized);
      if (typeof operationId !== 'string' || operationId === '')
        throw new InvalidRequestError({ message: 'forget needs an operationId.' });
      const requestDigest = await forgetRequestDigest(normalized, id);
      const outcome = await write((s) =>
        sqliteTransaction(s.db, (): ForgetOutcome => {
          // The forget is an operation: a repeated id replays, another's id conflicts.
          const stored = readReceipt(s, operationId);
          if (stored) {
            refuseForeignForget(stored, operationId, requestDigest);
            return { revisions: [], alreadyForgotten: forgottenIn(s, id, key) };
          }
          syncFts(s, true);
          const record = one(s, 'SELECT scope_key FROM deuz_vmem_records WHERE id = ?', [id]);
          let rows: Record<string, unknown>[] = [];
          const alreadyForgotten = !record && forgottenIn(s, id, key);
          if (record && text(record.scope_key) === key) {
            rows = all(
              s,
              'SELECT seq, revision, text FROM deuz_vmem_revisions WHERE id = ? ORDER BY revision',
              [id],
            );
            for (const row of rows) unindexRevision(s, num(row.seq), text(row.text));
            run(s, 'DELETE FROM deuz_vmem_vectors WHERE id = ?', [id]);
            run(s, 'DELETE FROM deuz_vmem_revisions WHERE id = ?', [id]);
            run(s, 'DELETE FROM deuz_vmem_records WHERE id = ?', [id]);
            run(
              s,
              'INSERT OR REPLACE INTO deuz_vmem_forgotten (id, scope_key, operation_id, forgotten_at) VALUES (?, ?, ?, ?)',
              [id, key, operationId, clock.now()],
            );
            run(
              s,
              'UPDATE deuz_vmem_receipts SET redacted = 1 WHERE operation_id IN ' +
                '(SELECT operation_id FROM deuz_vmem_receipt_records WHERE record_id = ?)',
              [id],
            );
            run(s, 'DELETE FROM deuz_vmem_receipt_records WHERE record_id = ?', [id]);
            markWritten(s);
          }
          // Committed even when it deleted nothing: the scope moves and the id is taken.
          const scopeRevision = readScopeRevision(s, key) + 1;
          run(
            s,
            'INSERT INTO deuz_vmem_scopes (scope_key, revision) VALUES (?, ?) ' +
              'ON CONFLICT(scope_key) DO UPDATE SET revision = excluded.revision',
            [key, scopeRevision],
          );
          const receipt = forgetReceipt(
            normalized,
            operationId,
            requestDigest,
            scopeRevision,
            clock.now(),
          );
          run(
            s,
            'INSERT INTO deuz_vmem_receipts (operation_id, request_digest, committed_at, redacted, receipt) VALUES (?, ?, ?, 0, ?)',
            [operationId, requestDigest, receipt.committedAt, encodeReceipt(receipt)],
          );
          return { revisions: rows.map((row) => num(row.revision)), alreadyForgotten };
        }),
      );
      return {
        scope: normalized,
        recordId: id,
        revisions: outcome.revisions,
        operationId,
        ...(outcome.alreadyForgotten ? { alreadyForgotten: true as const } : {}),
      };
    },

    embeddings: {
      active() {
        return connection.use((s) => readActive(s));
      },

      begin(request) {
        validateGeneration(request);
        return write((s) =>
          sqliteTransaction(s.db, () => {
            const pending = one(
              s,
              "SELECT * FROM deuz_vmem_generations WHERE status = 'pending' AND model_id = ? AND dims = ? " +
                'ORDER BY generation DESC LIMIT 1',
              [request.modelId, request.dims],
            );
            if (pending) return toGeneration(pending);
            return toGeneration(
              one(
                s,
                "INSERT INTO deuz_vmem_generations (model_id, dims, status, created_at) VALUES (?, ?, 'pending', ?) RETURNING *",
                [request.modelId, request.dims, clock.now()],
              )!,
            );
          }),
        );
      },

      pending(generation, pendingOptions): Promise<MemoryReembedItem[]> {
        const limit = pendingOptions?.limit;
        if (!Number.isSafeInteger(limit) || limit! < 1)
          throw new InvalidRequestError({ message: 'embeddings.pending needs a positive limit.' });
        return connection.use((s) =>
          all(
            s,
            'SELECT r.record, r.text_digest FROM deuz_vmem_records c ' +
              'JOIN deuz_vmem_revisions r ON r.id = c.id AND r.revision = c.revision ' +
              'LEFT JOIN deuz_vmem_vectors v ON v.generation = ? AND v.id = c.id AND v.revision = c.revision ' +
              'WHERE v.id IS NULL AND c.id > ? ORDER BY c.id LIMIT ?',
            [generation, pendingOptions.after ?? '', limit!],
          ).map((row) => {
            const record = decodeRecord(text(row.record));
            return {
              id: record.id,
              revision: record.revision,
              scope: record.scope,
              text: record.text,
              textDigest: text(row.text_digest) as Sha256Digest,
            };
          }),
        );
      },

      put(generation, vectors) {
        return write((s) =>
          sqliteTransaction(s.db, () => {
            const target = readGeneration(s, generation);
            if (!target || target.status === 'retired')
              throw new InvalidRequestError({
                message: `Embedding generation ${generation} is not open for vectors.`,
              });
            for (const item of vectors) assertGenerationVector(target, item.vector);
            let stored = 0;
            for (const item of vectors) {
              const current = one(
                s,
                'SELECT r.text_digest FROM deuz_vmem_records c JOIN deuz_vmem_revisions r ' +
                  'ON r.id = c.id AND r.revision = c.revision WHERE c.id = ? AND c.revision = ?',
                [item.id, item.revision],
              );
              if (!current || text(current.text_digest) !== item.textDigest) continue;
              run(
                s,
                'INSERT OR REPLACE INTO deuz_vmem_vectors (generation, id, revision, text_digest, vector) VALUES (?, ?, ?, ?, ?)',
                [generation, item.id, item.revision, item.textDigest, encodeVector(item.vector)],
              );
              stored++;
            }
            return stored;
          }),
        );
      },

      activate(generation) {
        return write((s) =>
          sqliteTransaction(s.db, () => {
            const target = readGeneration(s, generation);
            if (!target)
              throw new InvalidRequestError({
                message: `Unknown embedding generation ${generation}.`,
              });
            if (target.status === 'active') return true;
            const missing = one(
              s,
              'SELECT COUNT(*) AS n FROM deuz_vmem_records c LEFT JOIN deuz_vmem_vectors v ' +
                'ON v.generation = ? AND v.id = c.id AND v.revision = c.revision WHERE v.id IS NULL',
              [generation],
            );
            if (num(missing?.n) > 0) return false;
            run(s, "UPDATE deuz_vmem_generations SET status = 'retired' WHERE status = 'active'");
            run(s, "UPDATE deuz_vmem_generations SET status = 'active' WHERE generation = ?", [
              generation,
            ]);
            // A retired generation answers nothing any more: its vectors go.
            run(
              s,
              "DELETE FROM deuz_vmem_vectors WHERE generation IN (SELECT generation FROM deuz_vmem_generations WHERE status = 'retired')",
            );
            return true;
          }),
        );
      },
    },

    pruneHistory(pruneOptions) {
      const olderThan = pruneOptions?.olderThan;
      if (typeof olderThan !== 'number' || !Number.isFinite(olderThan))
        throw new InvalidRequestError({ message: 'pruneHistory needs olderThan (epoch ms).' });
      const key = pruneOptions.scope ? scopeKey(pruneOptions.scope) : undefined;
      return retentionSpan(options.observer, clock, 'prune-history', () =>
        write((s) =>
          sqliteTransaction(s.db, () => {
            syncFts(s, true);
            const rows = all(
              s,
              'SELECT r.seq, r.id, r.revision, r.text FROM deuz_vmem_revisions r ' +
                'JOIN deuz_vmem_records c ON c.id = r.id ' +
                'JOIN deuz_vmem_revisions cur ON cur.id = c.id AND cur.revision = c.revision ' +
                'WHERE r.revision < c.revision AND r.recorded_at < ? ' +
                "AND (cur.status = 'retracted' OR (cur.expires_at IS NOT NULL AND cur.expires_at <= ?))" +
                (key ? ' AND c.scope_key = ?' : ''),
              key ? [olderThan, clock.now(), key] : [olderThan, clock.now()],
            );
            for (const row of rows) {
              unindexRevision(s, num(row.seq), text(row.text));
              run(s, 'DELETE FROM deuz_vmem_vectors WHERE id = ? AND revision = ?', [
                text(row.id),
                num(row.revision),
              ]);
              run(s, 'DELETE FROM deuz_vmem_revisions WHERE seq = ?', [num(row.seq)]);
            }
            if (rows.length) markWritten(s);
            return rows.length;
          }),
        ),
      );
    },

    async pruneOperations(pruneOptions) {
      const olderThan = pruneOptions?.olderThan;
      if (typeof olderThan !== 'number' || !Number.isFinite(olderThan))
        throw new InvalidRequestError({ message: 'pruneOperations needs olderThan (epoch ms).' });
      const count = await retentionSpan(options.observer, clock, 'prune-operations', () =>
        write((s) =>
          sqliteTransaction(s.db, () => {
            run(
              s,
              'DELETE FROM deuz_vmem_receipt_records WHERE operation_id IN ' +
                '(SELECT operation_id FROM deuz_vmem_receipts WHERE committed_at < ?)',
              [olderThan],
            );
            return run(s, 'DELETE FROM deuz_vmem_receipts WHERE committed_at < ?', [olderThan]);
          }),
        ),
      );
      if (count > 0) logger.warn(pruneOperationsWarning(count), { count });
      return count;
    },

    close() {
      return connection.close();
    },
  };
  return store;
}
