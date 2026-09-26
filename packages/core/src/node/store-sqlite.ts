/**
 * store-sqlite.ts — the ONE-FILE persistent store pack (2.0). Ships as
 * `@deuz-sdk/core/stores/sqlite`; zero runtime dependencies, because Node 22.13+
 * / 23.4+ carry `node:sqlite` unflagged.
 *
 * Four seams, one database file: `MemoryStore` (with a real FTS5 + vector
 * hybrid search), `ChatStore`, `SessionStore`, and `RunStore`. They are handed
 * back as a PACK rather than one object because a single object cannot
 * implement `MemoryStore` and `SessionStore` at once — `delete(ids: string[])`
 * and `delete(runId: string)` are the same method name with incompatible
 * signatures, and `list()` collides the same way.
 *
 * The factory is SYNCHRONOUS (the `createClient` idiom) and opens lazily: the
 * `await import('node:sqlite')` happens on the first store call and is memoized,
 * so constructing a pack in module scope never pays for (or fails on) a database
 * you might not touch. `options.database` bypasses the import entirely —
 * `SqliteDatabaseLike` is a STRUCTURAL seam that `DatabaseSync` and
 * better-sqlite3 both satisfy, which is how better-sqlite3 works here with no
 * peer dependency at all.
 */
import type { ChatRecord, ChatStore } from '../chat';
import { serializeChatRecord, deserializeChatRecord } from '../chat';
import { serializeCheckpoint, deserializeCheckpoint } from '../durable';
import type { MemoryHit, MemoryKind, MemoryRecord, MemoryScope, MemoryStore } from '../memory';
import type { AgentCheckpoint, SessionStore } from '../types/session';
import type { RunRecord, RunStore } from '../types/runtime';
import { cosineSimilarity, decodeVector, encodeVector, rankFuse } from '../internal/vector';
import { ensureBusyTimeout } from './sqlite-open';

// ===================================================================
// The structural driver seam
// ===================================================================

/** Everything a bound statement must offer. `node:sqlite`'s `StatementSync` and better-sqlite3's `Statement` both do. */
export interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * The stable subset of a synchronous SQLite handle this store uses. Deliberately
 * four members: anything richer (transaction helpers, `pragma()`, `iterate()`)
 * differs between `DatabaseSync` and better-sqlite3, and depending on it would
 * turn the zero-peer injection story into a compatibility matrix.
 */
export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): void;
  close(): void;
}

export interface SqliteStoreOptions {
  /** Database file, or `':memory:'` for an ephemeral one. */
  path: string;
  /**
   * Use THIS handle instead of opening `node:sqlite` (better-sqlite3, a pooled
   * connection, a test double). The pack owns it from here on — `close()`
   * closes it.
   */
  database?: SqliteDatabaseLike;
  /** `PRAGMA journal_mode = WAL` for file databases. Default on; ignored for `':memory:'`. */
  wal?: boolean;
  /** Build the FTS5 index for lexical search. Default on, with an automatic LIKE fallback. */
  fts?: boolean;
}

/** The four stores plus the two lifecycle helpers that belong to the pack, not to any one seam. */
export interface SqliteStores {
  /** Full `MemoryStore`, including the 2.0 `findByHash` / `deleteExpired` fast paths. */
  memory: Required<MemoryStore>;
  chats: Required<ChatStore>;
  sessions: Required<SessionStore>;
  runs: Required<RunStore>;
  /** TTL sweep across every scope (`MemoryStore.deleteExpired` is the scoped one). Returns rows removed. */
  sweepExpiredMemories(now?: number): Promise<number>;
  /** Close the database handle. Idempotent; a pack that never opened one is a no-op. */
  close(): Promise<void>;
}

/**
 * The one error a caller can actually act on: which Node versions ship the
 * module, the flag that unlocks it on the ones that don't, and the escape hatch
 * that needs neither.
 */
const UNAVAILABLE =
  'createSqliteStores: node:sqlite is unavailable. It ships unflagged from Node 22.13 / 23.4; ' +
  'on Node 22.5–22.12 run node with --experimental-sqlite, or pass options.database ' +
  '(a better-sqlite3-compatible handle).';

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabaseLike;
}

// ===================================================================
// Schema v1
// ===================================================================

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS deuz_memory (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  actor_id TEXT,
  chat_id TEXT,
  importance REAL,
  metadata TEXT,
  embedding BLOB,
  embedding_model_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  expires_at INTEGER,
  valid_at INTEGER,
  invalid_at INTEGER
);
CREATE INDEX IF NOT EXISTS deuz_memory_scope_idx ON deuz_memory (user_id, agent_id, chat_id);
CREATE INDEX IF NOT EXISTS deuz_memory_hash_idx ON deuz_memory (hash);
CREATE INDEX IF NOT EXISTS deuz_memory_expiry_idx ON deuz_memory (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS deuz_chats (
  chat_id TEXT PRIMARY KEY,
  user_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  actor_id TEXT,
  scope_chat_id TEXT,
  parent_id TEXT,
  record TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deuz_chats_scope_idx ON deuz_chats (user_id, agent_id, scope_chat_id);

CREATE TABLE IF NOT EXISTS deuz_sessions (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deuz_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deuz_runs_status_idx ON deuz_runs (status);
`;

/**
 * The external-content FTS5 index. The virtual table comes FIRST on purpose: if
 * `fts5` is missing from the build, `CREATE VIRTUAL TABLE` fails and no trigger
 * is ever created — a trigger left behind pointing at a table that does not
 * exist would break every subsequent `upsert`.
 */
const SCHEMA_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS deuz_memory_fts
  USING fts5(text, content='deuz_memory', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS deuz_memory_fts_ai AFTER INSERT ON deuz_memory BEGIN
  INSERT INTO deuz_memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS deuz_memory_fts_ad AFTER DELETE ON deuz_memory BEGIN
  INSERT INTO deuz_memory_fts(deuz_memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS deuz_memory_fts_au AFTER UPDATE OF text ON deuz_memory BEGIN
  INSERT INTO deuz_memory_fts(deuz_memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO deuz_memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

// ===================================================================
// Value plumbing
// ===================================================================

type SqlValue = string | number | null | Uint8Array;

/** SQLite binds `null`, never `undefined` — every optional column goes through here. */
function nullable(value: string | number | null | undefined): SqlValue {
  return value === undefined ? null : value;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Drivers may hand integers back as `bigint` (better-sqlite3 `safeIntegers`, `setReadBigInts`). */
function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function bytesOf(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // a hand-edited row must not kill a read
  }
}

/** Column order is the DECLARED order, so the generated SQL — and therefore the statement-cache key — is stable. */
const MEMORY_SCOPE_COLUMNS: ReadonlyArray<readonly [keyof MemoryScope, string]> = [
  ['userId', 'user_id'],
  ['agentId', 'agent_id'],
  ['runId', 'run_id'],
  ['actorId', 'actor_id'],
  ['chatId', 'chat_id'],
];

/** Same five fields on `deuz_chats`, where `chat_id` is already the primary key. */
const CHAT_SCOPE_COLUMNS: ReadonlyArray<readonly [keyof MemoryScope, string]> = [
  ['userId', 'user_id'],
  ['agentId', 'agent_id'],
  ['runId', 'run_id'],
  ['actorId', 'actor_id'],
  ['chatId', 'scope_chat_id'],
];

/**
 * `matchesScope` as SQL: only the fields the caller actually SET become
 * predicates, so `{ userId }` matches every chat of that user regardless of
 * `chatId`. An unset field is not a `NULL` test — it is no test at all.
 */
function scopeFilter(
  scope: MemoryScope | undefined,
  columns: ReadonlyArray<readonly [keyof MemoryScope, string]>,
  alias = '',
): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [];
  let sql = '';
  if (!scope) return { sql, params };
  for (const [key, column] of columns) {
    const value = scope[key];
    if (value === undefined) continue;
    sql += ` AND ${alias}${column} = ?`;
    params.push(value);
  }
  return { sql, params };
}

const MEMORY_COLUMNS = [
  'id',
  'text',
  'hash',
  'kind',
  'user_id',
  'agent_id',
  'run_id',
  'actor_id',
  'chat_id',
  'importance',
  'metadata',
  'embedding',
  'embedding_model_id',
  'created_at',
  'updated_at',
  'last_accessed_at',
  'expires_at',
  'valid_at',
  'invalid_at',
] as const;

const MEMORY_SELECT = MEMORY_COLUMNS.map((c) => `m.${c}`).join(', ');
const MEMORY_PLACEHOLDERS = MEMORY_COLUMNS.map(() => '?').join(', ');

function memoryParams(record: MemoryRecord): SqlValue[] {
  return [
    record.id,
    record.text,
    record.hash,
    record.kind,
    nullable(record.scope.userId),
    nullable(record.scope.agentId),
    nullable(record.scope.runId),
    nullable(record.scope.actorId),
    nullable(record.scope.chatId),
    nullable(record.importance),
    record.metadata ? JSON.stringify(record.metadata) : null,
    record.embedding ? encodeVector(record.embedding) : null,
    nullable(record.embeddingModelId),
    record.createdAt,
    record.updatedAt,
    nullable(record.lastAccessedAt),
    nullable(record.expiresAt),
    nullable(record.validAt),
    nullable(record.invalidAt),
  ];
}

/**
 * Row → `MemoryRecord`. The embedding comes back through the Float32 codec, so
 * a stored `0.6` reads as `0.6000000238418579`: the store is a float32 index,
 * exactly like pgvector, and the difference is far below any embedding model's
 * noise floor. Callers that need bit-exact vectors keep their own copy.
 */
function hydrateMemory(row: Record<string, unknown>): MemoryRecord {
  const scope: MemoryScope = {};
  for (const [key, column] of MEMORY_SCOPE_COLUMNS) {
    const value = textOf(row[column]);
    if (value !== undefined) scope[key] = value;
  }
  const record: MemoryRecord = {
    id: textOf(row.id) ?? '',
    text: textOf(row.text) ?? '',
    hash: textOf(row.hash) ?? '',
    kind: (textOf(row.kind) ?? 'semantic') as MemoryKind,
    scope,
    createdAt: numberOf(row.created_at) ?? 0,
    updatedAt: numberOf(row.updated_at) ?? 0,
  };
  const importance = numberOf(row.importance);
  if (importance !== undefined) record.importance = importance;
  const metadata = parseJsonObject(row.metadata);
  if (metadata) record.metadata = metadata;
  const embedding = bytesOf(row.embedding);
  if (embedding) record.embedding = decodeVector(embedding);
  const embeddingModelId = textOf(row.embedding_model_id);
  if (embeddingModelId !== undefined) record.embeddingModelId = embeddingModelId;
  const lastAccessedAt = numberOf(row.last_accessed_at);
  if (lastAccessedAt !== undefined) record.lastAccessedAt = lastAccessedAt;
  const expiresAt = numberOf(row.expires_at);
  if (expiresAt !== undefined) record.expiresAt = expiresAt;
  const validAt = numberOf(row.valid_at);
  if (validAt !== undefined) record.validAt = validAt;
  const invalidAt = numberOf(row.invalid_at);
  if (invalidAt !== undefined) record.invalidAt = invalidAt;
  return record;
}

/**
 * `MemoryQuery.filter` as a client-side predicate — the twin of Postgres'
 * `metadata @> $n::jsonb`. SQLite stores `metadata` as opaque JSON TEXT, so the
 * containment test cannot be pushed into the scope index; ignoring the filter
 * instead (which is what this store used to do) silently widens a query the
 * caller believes is narrow.
 */
function matchesMetadataFilter(
  record: MemoryRecord,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter) return true;
  const metadata = record.metadata ?? {};
  return Object.entries(filter).every(
    ([key, value]) => JSON.stringify(metadata[key]) === JSON.stringify(value),
  );
}

/** Rows a filtered query scans before the client-side predicate narrows them. */
const FILTER_SCAN_LIMIT = 1000;

/** Post-SQL row predicate; `KEEP_ANY` is the unfiltered identity. */
type MemoryKeep = (record: MemoryRecord) => boolean;
const KEEP_ANY: MemoryKeep = () => true;

/** Wrap a user query as ONE FTS5 phrase — `"` is the only metacharacter left, and it doubles. */
function toFtsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** `%`, `_` and the escape character itself, for the LIKE fallback. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Every `IN (…)` list is padded to a FIXED width by repeating its last value.
 * `IN` is set semantics, so a duplicate changes nothing — but an unpadded list
 * would mint a new SQL string (and a new prepared statement) for every distinct
 * input length, which defeats the statement cache the whole store is built on.
 */
const IN_CHUNK = 50;

function chunkPadded(values: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const slice = values.slice(i, i + IN_CHUNK);
    const last = slice[slice.length - 1]!;
    while (slice.length < IN_CHUNK) slice.push(last);
    chunks.push(slice);
  }
  return chunks;
}

const IN_PLACEHOLDERS = Array.from({ length: IN_CHUNK }, () => '?').join(', ');

// ===================================================================
// The handle: open, migrate, cache statements
// ===================================================================

interface SqliteHandle {
  db: SqliteDatabaseLike;
  /** False when fts5 is unavailable or `options.fts === false` — lexical search falls back to LIKE. */
  fts: boolean;
  all(sql: string, params?: SqlValue[]): Record<string, unknown>[];
  get(sql: string, params?: SqlValue[]): Record<string, unknown> | undefined;
  /** Returns the affected-row count. */
  run(sql: string, params?: SqlValue[]): number;
  transaction<T>(fn: () => T): T;
}

async function openDatabase(options: SqliteStoreOptions): Promise<SqliteDatabaseLike> {
  if (options.database) return options.database;
  let Database: NodeSqliteModule['DatabaseSync'] | undefined;
  try {
    // `as string` keeps tsup's dts builder from statically resolving the
    // node: specifier (same trick as node/chat-store.ts). Reading the export
    // happens INSIDE the try: a runtime that ships a stub module can throw on
    // the property access rather than on the import, and both mean the same
    // thing to the caller.
    const mod = (await import('node:sqlite' as string)) as unknown as NodeSqliteModule;
    if (typeof mod?.DatabaseSync === 'function') Database = mod.DatabaseSync;
  } catch (err) {
    throw new Error(UNAVAILABLE, { cause: err });
  }
  if (!Database) throw new Error(UNAVAILABLE);
  // Deliberately outside the try — an unwritable path is a different problem
  // and deserves SQLite's own message, not the version matrix.
  return new Database(options.path);
}

function migrate(handle: SqliteHandle): void {
  const current = numberOf(handle.get('PRAGMA user_version')?.user_version) ?? 0;
  if (current >= SCHEMA_VERSION) return;
  handle.transaction(() => {
    handle.db.exec(SCHEMA_V1);
    // A PRAGMA value cannot be bound; SCHEMA_VERSION is a module constant, so
    // there is nothing user-controlled in this string.
    handle.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/**
 * Build the lexical index, in its OWN transaction and its own try/catch: a
 * SQLite build without fts5 must degrade to LIKE search, never take the whole
 * store down. A rollback on failure guarantees no half-built index survives.
 *
 * This is not a hypothetical branch. `node:sqlite` shipping does NOT imply fts5
 * shipped with it — Node 22.14 answers `USING fts5` with "no such module: fts5"
 * while 24.x has it — so the same code takes both paths across a normal support
 * matrix, and the triggers must never outlive a failed table.
 */
function setupFts(handle: SqliteHandle): boolean {
  try {
    const existed = handle.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deuz_memory_fts'",
    );
    handle.transaction(() => {
      handle.db.exec(SCHEMA_FTS);
      // Adopting an existing database that was written with `fts: false` — the
      // triggers only see FUTURE writes, so backfill what is already there.
      if (!existed)
        handle.db.exec("INSERT INTO deuz_memory_fts(deuz_memory_fts) VALUES('rebuild')");
    });
    // Prove a MATCH actually runs before promising lexical search.
    handle.all('SELECT rowid FROM deuz_memory_fts WHERE deuz_memory_fts MATCH ? LIMIT 1', [
      toFtsPhrase('deuz'),
    ]);
    return true;
  } catch {
    return false;
  }
}

function createHandle(db: SqliteDatabaseLike): SqliteHandle {
  const statements = new Map<string, SqliteStatementLike>();
  const prepare = (sql: string): SqliteStatementLike => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  return {
    db,
    fts: false,
    all(sql, params = []) {
      return prepare(sql).all(...params) as Record<string, unknown>[];
    },
    get(sql, params = []) {
      return prepare(sql).get(...params) as Record<string, unknown> | undefined;
    },
    run(sql, params = []) {
      const result = prepare(sql).run(...params);
      return numberOf((result as { changes?: unknown } | undefined)?.changes) ?? 0;
    },
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the failure that got us here may already have unwound it */
        }
        throw err;
      }
    },
  };
}

// ===================================================================
// The factory
// ===================================================================

/**
 * Create the SQLite-backed store pack. Synchronous, like every other factory in
 * this SDK: the database opens on FIRST USE and the promise is memoized, so a
 * pack built at module scope costs nothing until a store method runs — and an
 * unsupported runtime surfaces as a rejected store call carrying the actionable
 * message, not as a throw out of module evaluation.
 *
 * ```ts
 * const stores = createSqliteStores({ path: './agent.db' });
 * await streamChat({ model, messages, chat: { store: stores.chats, chatId, scope } });
 * ```
 */
export function createSqliteStores(options: SqliteStoreOptions): SqliteStores {
  let opening: Promise<SqliteHandle> | undefined;
  let closed = false;

  const open = async (): Promise<SqliteHandle> => {
    const db = await openDatabase(options);
    try {
      return prepare(db);
    } catch (error) {
      // An injected handle stays open: the next call retries on it.
      if (!options.database) db.close();
      throw error;
    }
  };

  const prepare = (db: SqliteDatabaseLike): SqliteHandle => {
    ensureBusyTimeout(db);
    const handle = createHandle(db);
    if (options.path !== ':memory:' && options.wal !== false) {
      try {
        db.exec('PRAGMA journal_mode = WAL');
      } catch {
        /* a read-only mount / an injected in-memory handle keeps its journal */
      }
    }
    // REQUIRED for correctness, not tuning: `INSERT OR REPLACE` deletes the
    // conflicting row, and with recursive triggers OFF that delete does NOT
    // fire `deuz_memory_fts_ad`. The old rowid then lingers in the external-
    // content index and the next integrity check reports "database disk image
    // is malformed". Verified against node:sqlite before this was written.
    let recursiveTriggers = true;
    try {
      db.exec('PRAGMA recursive_triggers = ON');
    } catch {
      // Without it the index would corrupt on the first replace, so the index
      // is not built at all and lexical search serves LIKE — the same degraded
      // path a build without fts5 takes. A slower search beats a malformed one.
      recursiveTriggers = false;
    }
    migrate(handle);
    handle.fts = options.fts === false || !recursiveTriggers ? false : setupFts(handle);
    return handle;
  };

  const handle = (): Promise<SqliteHandle> => {
    if (!opening) {
      opening = open();
      // A failed open must not poison the pack for the rest of the process.
      opening.catch(() => {
        opening = undefined;
      });
    }
    return opening;
  };

  // --- memory ------------------------------------------------------

  /** Candidate predicate shared by search/list/findByHash — scope, kind, temporality. */
  const memoryWhere = (
    scope: MemoryScope | undefined,
    kind: MemoryKind | undefined,
    asOf: number | undefined,
  ): { sql: string; params: SqlValue[] } => {
    const scoped = scopeFilter(scope, MEMORY_SCOPE_COLUMNS, 'm.');
    const params: SqlValue[] = [...scoped.params];
    // A point-in-time query REPLACES the live filter: a fact superseded at
    // T+500 was still true at T, so `asOf: T` must see it. Without `asOf` the
    // store shows the present, which means soft-deleted rows are invisible —
    // exactly what the in-memory reference store does.
    let sql = `1 = 1${scoped.sql}`;
    if (kind !== undefined) {
      sql += ' AND m.kind = ?';
      params.push(kind);
    }
    if (asOf !== undefined) {
      // COALESCE, not `valid_at IS NULL OR …`: an absent `validAt` defaults to
      // `createdAt` (the documented field default, and what the Postgres and
      // Redis backends do), NOT to "valid since the beginning of time" — which
      // would make a point-in-time query invent facts that did not exist yet.
      sql +=
        ' AND COALESCE(m.valid_at, m.created_at) <= ? AND (m.invalid_at IS NULL OR m.invalid_at > ?)';
      params.push(asOf, asOf);
    } else {
      sql += ' AND m.invalid_at IS NULL';
    }
    return { sql, params };
  };

  /**
   * Vector recall: pull the freshest candidates, decode their blobs, rank in JS.
   * A pure-SQL cosine would need a distance extension; a bounded prefetch
   * (`max(1000, topK * 50)`) keeps one round-trip and stays honest about being
   * an approximation on very large scopes.
   */
  const vectorSearch = async (
    embedding: number[],
    where: { sql: string; params: SqlValue[] },
    topK: number,
    keep: MemoryKeep = KEEP_ANY,
  ): Promise<MemoryHit[]> => {
    const h = await handle();
    const rows = h.all(
      `SELECT ${MEMORY_SELECT} FROM deuz_memory m WHERE ${where.sql} ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
      [...where.params, Math.max(1000, topK * 50)],
    );
    return rows
      .map((row) => {
        const record = hydrateMemory(row);
        return {
          record,
          score: record.embedding ? cosineSimilarity(embedding, record.embedding) : 0,
        };
      })
      .filter((hit) => keep(hit.record))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  };

  /**
   * Substring recall — the fallback when fts5 is off or the phrase will not
   * parse. `scan` is the SQL `LIMIT`, which is wider than `topK` only when a
   * client-side `keep` still has to narrow the rows: applying `LIMIT topK`
   * before the predicate would under-return.
   */
  const likeSearch = async (
    text: string,
    where: { sql: string; params: SqlValue[] },
    topK: number,
    keep: MemoryKeep = KEEP_ANY,
    scan: number = topK,
  ): Promise<MemoryHit[]> => {
    const h = await handle();
    const rows = h.all(
      `SELECT ${MEMORY_SELECT} FROM deuz_memory m WHERE ${where.sql} AND m.text LIKE ? ESCAPE '\\' ` +
        'ORDER BY m.updated_at DESC, m.id ASC LIMIT ?',
      [...where.params, `%${escapeLike(text)}%`, scan],
    );
    // Substring matching has no gradations: a hit is a hit.
    return rows
      .map((row) => ({ record: hydrateMemory(row), score: 1 }))
      .filter((hit) => keep(hit.record))
      .slice(0, topK);
  };

  /**
   * Lexical recall over FTS5. `bm25()` returns a NEGATIVE relevance (better =
   * more negative), so the sign flips and the column is normalized against the
   * best hit — a raw bm25 magnitude depends on corpus statistics and would make
   * `score` meaningless to compare across queries.
   */
  const lexicalSearch = async (
    text: string,
    where: { sql: string; params: SqlValue[] },
    topK: number,
    keep: MemoryKeep = KEEP_ANY,
    scan: number = topK,
  ): Promise<MemoryHit[]> => {
    const h = await handle();
    if (!h.fts) return likeSearch(text, where, topK, keep, scan);
    let rows: Record<string, unknown>[];
    try {
      rows = h.all(
        `SELECT ${MEMORY_SELECT}, bm25(deuz_memory_fts) AS deuz_bm25 FROM deuz_memory_fts ` +
          'JOIN deuz_memory m ON m.rowid = deuz_memory_fts.rowid ' +
          `WHERE deuz_memory_fts MATCH ? AND ${where.sql} ORDER BY deuz_bm25 LIMIT ?`,
        [toFtsPhrase(text), ...where.params, scan],
      );
    } catch {
      // An unparseable phrase (or a corrupted index) is a query-level problem,
      // not a store-level one — answer it with LIKE instead of throwing.
      return likeSearch(text, where, topK, keep, scan);
    }
    // Normalized against the best SURVIVING hit, so a filtered query still tops
    // out at 1 — a raw bm25 magnitude is meaningless across queries anyway.
    const raw = rows
      .map((row) => ({
        record: hydrateMemory(row),
        score: -(numberOf(row.deuz_bm25) ?? 0),
      }))
      .filter((hit) => keep(hit.record))
      .slice(0, topK);
    const best = raw[0]?.score ?? 0;
    if (best <= 0) return raw.map((hit) => ({ record: hit.record, score: 1 }));
    return raw.map((hit) => ({ record: hit.record, score: hit.score / best }));
  };

  const memory: Required<MemoryStore> = {
    async upsert(records) {
      if (records.length === 0) return;
      const h = await handle();
      const sql = `INSERT OR REPLACE INTO deuz_memory (${MEMORY_COLUMNS.join(', ')}) VALUES (${MEMORY_PLACEHOLDERS})`;
      h.transaction(() => {
        for (const record of records) h.run(sql, memoryParams(record));
      });
    },

    async get(id, scope) {
      const h = await handle();
      const scoped = scopeFilter(scope, MEMORY_SCOPE_COLUMNS, 'm.');
      const row = h.get(`SELECT ${MEMORY_SELECT} FROM deuz_memory m WHERE m.id = ?${scoped.sql}`, [
        id,
        ...scoped.params,
      ]);
      return row ? hydrateMemory(row) : null;
    },

    async search(query) {
      const h = await handle();
      const topK = query.topK ?? 5;
      const where = memoryWhere(query.scope, query.kind, query.asOf);
      const embedding = query.embedding?.length ? query.embedding : undefined;
      const text = query.text?.trim() ? query.text : undefined;
      const filter =
        query.filter && Object.keys(query.filter).length > 0 ? query.filter : undefined;
      const keep: MemoryKeep = filter
        ? (record) => matchesMetadataFilter(record, filter)
        : KEEP_ANY;
      /** SQL `LIMIT`: widened whenever `keep` still has to remove rows after it. */
      const scanFor = (take: number): number => (filter ? Math.max(FILTER_SCAN_LIMIT, take) : take);

      if (!embedding && !text) {
        const rows = h.all(
          `SELECT ${MEMORY_SELECT} FROM deuz_memory m WHERE ${where.sql} ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
          [...where.params, scanFor(topK)],
        );
        return rows
          .map((row) => ({ record: hydrateMemory(row), score: 0 }))
          .filter((hit) => keep(hit.record))
          .slice(0, topK);
      }
      if (embedding && !text) return vectorSearch(embedding, where, topK, keep);
      if (text && !embedding) return lexicalSearch(text, where, topK, keep, scanFor(topK));

      // Hybrid: cosine and bm25 live on incomparable scales, so only their
      // RANKS are fused (RRF, k = 60) — the same merge `hybridRetrieve` uses.
      const window = Math.max(topK, 20);
      const [dense, lexical] = await Promise.all([
        vectorSearch(embedding!, where, window, keep),
        lexicalSearch(text!, where, window, keep, scanFor(window)),
      ]);
      const byId = new Map<string, MemoryRecord>();
      for (const hit of [...dense, ...lexical]) byId.set(hit.record.id, hit.record);
      const fused = rankFuse<MemoryHit>([
        { key: (hit) => hit.record.id, items: dense },
        { key: (hit) => hit.record.id, items: lexical },
      ]);
      return [...fused.entries()]
        .map(([id, score]) => ({ record: byId.get(id)!, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },

    async list(scope, opts) {
      const h = await handle();
      const where = memoryWhere(scope, opts?.kind, undefined);
      const limit = opts?.limit ?? -1; // SQLite: a negative LIMIT means "no limit"
      const rows = h.all(
        `SELECT ${MEMORY_SELECT} FROM deuz_memory m WHERE ${where.sql} ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
        [...where.params, limit],
      );
      return rows.map(hydrateMemory);
    },

    async delete(ids) {
      if (ids.length === 0) return;
      const h = await handle();
      const sql = `DELETE FROM deuz_memory WHERE id IN (${IN_PLACEHOLDERS})`;
      h.transaction(() => {
        for (const chunk of chunkPadded(ids)) h.run(sql, chunk);
      });
    },

    async update(id, patch) {
      const existing = await memory.get(id);
      if (!existing) return;
      // Read-modify-write through the same upsert path: one statement, one
      // encoding of the record, no column-by-column UPDATE to keep in sync.
      await memory.upsert([{ ...existing, ...patch, id }]);
    },

    async findByHash(hashes, scope) {
      if (hashes.length === 0) return [];
      const h = await handle();
      const scoped = scopeFilter(scope, MEMORY_SCOPE_COLUMNS, 'm.');
      const sql =
        `SELECT ${MEMORY_SELECT} FROM deuz_memory m WHERE m.hash IN (${IN_PLACEHOLDERS})` +
        `${scoped.sql} AND m.invalid_at IS NULL`;
      const seen = new Set<string>();
      const out: MemoryRecord[] = [];
      for (const chunk of chunkPadded(hashes)) {
        for (const row of h.all(sql, [...chunk, ...scoped.params])) {
          const record = hydrateMemory(row);
          if (seen.has(record.id)) continue; // chunks can overlap on a padded tail
          seen.add(record.id);
          out.push(record);
        }
      }
      return out;
    },

    async deleteExpired(now, scope) {
      const h = await handle();
      const scoped = scopeFilter(scope, MEMORY_SCOPE_COLUMNS);
      return h.run(
        `DELETE FROM deuz_memory WHERE expires_at IS NOT NULL AND expires_at <= ?${scoped.sql}`,
        [now, ...scoped.params],
      );
    },
  };

  // --- chats -------------------------------------------------------

  const chats: Required<ChatStore> = {
    async saveChat(record: ChatRecord) {
      const h = await handle();
      h.run(
        'INSERT OR REPLACE INTO deuz_chats ' +
          '(chat_id, user_id, agent_id, run_id, actor_id, scope_chat_id, parent_id, record, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          record.chatId,
          nullable(record.scope.userId),
          nullable(record.scope.agentId),
          nullable(record.scope.runId),
          nullable(record.scope.actorId),
          nullable(record.scope.chatId),
          nullable(record.parentId),
          // The binary-safe codec, not JSON.stringify: an image part would
          // otherwise reload as `{ "0": 137, … }` and break the NEXT turn.
          serializeChatRecord(record),
          record.updatedAt,
        ],
      );
    },

    async loadChat(chatId: string) {
      const h = await handle();
      const row = h.get('SELECT record FROM deuz_chats WHERE chat_id = ?', [chatId]);
      const json = textOf(row?.record);
      if (json === undefined) return undefined;
      try {
        return deserializeChatRecord(json);
      } catch {
        return undefined;
      }
    },

    async deleteChat(chatId: string) {
      const h = await handle();
      h.run('DELETE FROM deuz_chats WHERE chat_id = ?', [chatId]);
    },

    async listChats(scope?: MemoryScope) {
      const h = await handle();
      const scoped = scopeFilter(scope, CHAT_SCOPE_COLUMNS);
      const rows = h.all(
        `SELECT chat_id FROM deuz_chats WHERE 1 = 1${scoped.sql} ORDER BY updated_at DESC, chat_id ASC`,
        scoped.params,
      );
      return rows.map((row) => textOf(row.chat_id) ?? '');
    },
  };

  // --- sessions ----------------------------------------------------

  const sessions: Required<SessionStore> = {
    async save(checkpoint: AgentCheckpoint) {
      const h = await handle();
      h.run(
        'INSERT OR REPLACE INTO deuz_sessions (run_id, status, step_index, checkpoint, created_at) ' +
          'VALUES (?, ?, ?, ?, ?)',
        [
          checkpoint.runId,
          checkpoint.status,
          checkpoint.stepIndex,
          serializeCheckpoint(checkpoint),
          checkpoint.createdAt,
        ],
      );
    },

    async load(runId: string) {
      const h = await handle();
      const row = h.get('SELECT checkpoint FROM deuz_sessions WHERE run_id = ?', [runId]);
      const json = textOf(row?.checkpoint);
      if (json === undefined) return undefined;
      try {
        return deserializeCheckpoint(json);
      } catch {
        return undefined;
      }
    },

    async delete(runId: string) {
      const h = await handle();
      h.run('DELETE FROM deuz_sessions WHERE run_id = ?', [runId]);
    },

    async list() {
      const h = await handle();
      const rows = h.all('SELECT run_id FROM deuz_sessions ORDER BY created_at ASC, run_id ASC');
      return rows.map((row) => textOf(row.run_id) ?? '');
    },
  };

  // --- runs --------------------------------------------------------

  const writeRun = async (record: RunRecord): Promise<void> => {
    const h = await handle();
    h.run(
      'INSERT OR REPLACE INTO deuz_runs (run_id, status, record, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [record.runId, record.status, JSON.stringify(record), record.createdAt, record.updatedAt],
    );
  };

  const runs: Required<RunStore> = {
    async create(record: RunRecord) {
      await writeRun(record);
    },

    async update(runId: string, patch: Partial<Omit<RunRecord, 'runId'>>) {
      const existing = await runs.get(runId);
      if (!existing) return; // unknown run — same no-op as the file-backed store
      await writeRun({ ...existing, ...patch, runId });
    },

    async get(runId: string) {
      const h = await handle();
      const row = h.get('SELECT record FROM deuz_runs WHERE run_id = ?', [runId]);
      const json = textOf(row?.record);
      if (json === undefined) return undefined;
      try {
        return JSON.parse(json) as RunRecord;
      } catch {
        return undefined;
      }
    },

    async list(filter) {
      const h = await handle();
      const rows = filter?.status
        ? h.all(
            'SELECT record FROM deuz_runs WHERE status = ? ORDER BY created_at ASC, run_id ASC',
            [filter.status],
          )
        : h.all('SELECT record FROM deuz_runs ORDER BY created_at ASC, run_id ASC');
      const out: RunRecord[] = [];
      for (const row of rows) {
        const json = textOf(row.record);
        if (json === undefined) continue;
        try {
          out.push(JSON.parse(json) as RunRecord);
        } catch {
          /* skip an unreadable row rather than failing the whole listing */
        }
      }
      return out;
    },

    async delete(runId: string) {
      const h = await handle();
      h.run('DELETE FROM deuz_runs WHERE run_id = ?', [runId]);
    },
  };

  return {
    memory,
    chats,
    sessions,
    runs,

    async sweepExpiredMemories(now?: number) {
      return memory.deleteExpired(now ?? Date.now());
    },

    async close() {
      if (!opening || closed) return;
      closed = true;
      let open: SqliteHandle;
      try {
        open = await opening;
      } catch {
        return; // the handle never existed — nothing to release
      }
      open.db.close();
    },
  };
}
