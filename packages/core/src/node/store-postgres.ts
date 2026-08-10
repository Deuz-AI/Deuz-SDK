/**
 * store-postgres.ts — the Postgres (+ optional pgvector) store pack (2.0).
 *
 * One `createPostgresStores(...)` call returns the four seams a production
 * deployment needs on the SAME connection: `MemoryStore` (memory.ts),
 * `ChatStore` (chat.ts), `SessionStore` (types/session.ts) and `RunStore`
 * (types/runtime.ts). They are four objects rather than one, because a single
 * object cannot implement both — `MemoryStore.delete(ids[])` and
 * `SessionStore.delete(runId)` collide on the same name.
 *
 * INJECTION FIRST. The only thing this module needs from a driver is
 * `query(sql, params) → { rows }`, so `PgClientLike` is that method and nothing
 * else: `pg.Pool`, `pg.Client`, `@neondatabase/serverless`, a Supabase pooler
 * wrapper or a hand-rolled proxy all satisfy it structurally. The
 * `connectionString` form is a convenience that lazily `import('pg')`s — the
 * driver is an OPTIONAL peer, never a runtime dependency, and the import only
 * happens if you take that path.
 *
 * ## Two embedding columns, on purpose
 *
 * `embedding_json DOUBLE PRECISION[]` is written on EVERY upsert and is the
 * source of truth. When pgvector is present a second `embedding vector(D)`
 * column is written ALONGSIDE it and search runs on the HNSW index. Nothing is
 * ever lost by starting without the extension: once a DBA installs it, the rows
 * written in fallback mode are upgraded in one statement —
 *
 * ```sql
 * UPDATE deuz_memory SET embedding = embedding_json::vector
 *  WHERE embedding IS NULL AND embedding_json IS NOT NULL;
 * ```
 *
 * — and the next `migrate()` adds the column + index for you. `CREATE EXTENSION`
 * is never issued: it needs superuser-ish rights on most managed hosts, so it
 * stays a deliberate DBA action (same reasoning as `CREATE SCHEMA`).
 *
 * ## Safety notes
 *
 * - The schema name is the ONE identifier that cannot be a bind parameter, so it
 *   is validated against `/^[a-z_][a-z0-9_]*$/` (exactly the identifiers that
 *   need no quoting) and rejected with `InvalidRequestError` otherwise. Every
 *   other value in every statement is a `$n` placeholder.
 * - The migration is sent as ONE multi-statement simple query wrapped in
 *   `BEGIN … COMMIT`. That matters: `pg.Pool.query('BEGIN')` followed by a
 *   separate `query(ddl)` can land on DIFFERENT pooled connections, which would
 *   silently defeat the transaction. One query is one connection.
 * - `BIGINT` columns come back from `pg` as STRINGS (int8 overflows a JS
 *   number), so every timestamp is coerced on read — never trust `row.created_at`
 *   to already be a number.
 */
import type { MemoryHit, MemoryQuery, MemoryRecord, MemoryScope, MemoryStore } from '../memory';
import type { ChatStore } from '../chat';
import { serializeChatRecord, deserializeChatRecord } from '../chat';
import type { AgentCheckpoint, SessionStore } from '../types/session';
import { serializeCheckpoint, deserializeCheckpoint } from '../durable';
import type { RunRecord, RunStore } from '../types/runtime';
import { InvalidRequestError } from '../errors';
import { cosineSimilarity } from '../internal/vector';

// ===================================================================
// Options + public shape
// ===================================================================

/**
 * The driver seam: one method, so `pg.Pool`, `pg.Client`, a serverless HTTP
 * driver or a test double all fit without adapters. `params` is omitted for
 * statements that carry no placeholders (DDL uses the simple query protocol,
 * which is what allows the multi-statement migration batch).
 */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A pool we created ourselves — the only client this module is allowed to close. */
interface PgPoolLike extends PgClientLike {
  end?(): Promise<void>;
}

export type PostgresStoreOptions = ({ client: PgClientLike } | { connectionString: string }) & {
  /** Schema holding the `deuz_*` tables. Default `'public'`; must already exist. */
  schema?: string;
  /**
   * - `'auto'` (default) — use pgvector when `pg_extension` reports it, else the
   *   `embedding_json` + JS-cosine fallback.
   * - `'require'` — refuse to migrate when the extension is missing.
   * - `'off'` — never probe, never create the `vector` column.
   */
  pgvector?: 'auto' | 'require' | 'off';
  /** Width of the `vector(D)` column. Default 1536 (OpenAI `text-embedding-3-small`). */
  dimensions?: number;
};

/** The four seams plus the pack's own lifecycle methods. */
export interface PostgresStores {
  /** Full `MemoryStore`, including the 2.0 `findByHash` / `deleteExpired` fast paths. */
  memory: Required<MemoryStore>;
  chats: Required<ChatStore>;
  sessions: Required<SessionStore>;
  runs: Required<RunStore>;
  /**
   * Create/patch the schema. Idempotent and memoized — every store method
   * awaits it first, so calling it yourself is optional (do it at boot to fail
   * fast instead of on the first memory write). A failed attempt is NOT cached:
   * the next call retries.
   */
  migrate(): Promise<void>;
  /** TTL sweep across every scope; returns how many rows were removed. */
  sweepExpiredMemories(now?: number): Promise<number>;
  /** Ends a pool this pack opened from `connectionString`. An INJECTED client is never closed. */
  close(): Promise<void>;
}

// ===================================================================
// Constants
// ===================================================================

/** Exactly the identifiers Postgres accepts unquoted (and folds to lower case). */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;
const SCHEMA_VERSION = '1';
const DEFAULT_DIMENSIONS = 1536;
/** Rows pulled for JS-side cosine when pgvector is unavailable (newest first). */
const FALLBACK_CANDIDATE_LIMIT = 1000;
const DEFAULT_TOP_K = 5;

/** Write order for `deuz_memory`; `id` is the conflict target, the rest are overwritten. */
const MEMORY_WRITE_COLUMNS = [
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
  'embedding_json',
  'embedding_model_id',
  'created_at',
  'updated_at',
  'last_accessed_at',
  'expires_at',
  'valid_at',
  'invalid_at',
] as const;

/**
 * Read set: the write set minus `embedding_json`. A 1536-dim array is ~20 KB of
 * text on the wire, so it is fetched ONLY by the fallback search that has to
 * score it — never by `get`/`list`/`search`, which is also why a loaded
 * `MemoryRecord` carries no `embedding` (documented as inline-for-the-in-memory
 * store).
 */
const MEMORY_READ_COLUMNS = MEMORY_WRITE_COLUMNS.filter((c) => c !== 'embedding_json').join(', ');

const MEMORY_SCOPE_COLUMNS = {
  userId: 'user_id',
  agentId: 'agent_id',
  runId: 'run_id',
  actorId: 'actor_id',
  chatId: 'chat_id',
} as const;

/** `deuz_chats.chat_id` is the chat's OWN identity, so the scope's chatId gets its own column. */
const CHAT_SCOPE_COLUMNS = {
  ...MEMORY_SCOPE_COLUMNS,
  chatId: 'scope_chat_id',
} as const;

// ===================================================================
// Small pure helpers
// ===================================================================

/** Placeholder allocator — every user value goes through this, never into the SQL text. */
interface Binder {
  params: unknown[];
  add(value: unknown): string;
}

function binder(initial: unknown[] = []): Binder {
  const params = [...initial];
  return {
    params,
    add(value) {
      params.push(value);
      return `$${params.length}`;
    },
  };
}

function validateSchema(schema: string): string {
  if (!SCHEMA_NAME_PATTERN.test(schema) || schema.length > MAX_IDENTIFIER_LENGTH) {
    throw new InvalidRequestError({
      message:
        `Invalid Postgres schema name '${schema}'. A schema is an identifier, not a bind ` +
        `parameter, so it must match /^[a-z_][a-z0-9_]*$/ and be at most ${MAX_IDENTIFIER_LENGTH} characters.`,
    });
  }
  return schema;
}

function validateDimensions(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16_000) {
    throw new InvalidRequestError({
      message: `Invalid pgvector dimensions '${dimensions}'. Expected an integer between 1 and 16000.`,
    });
  }
  return dimensions;
}

/**
 * pgvector's text input format. Non-finite components become 0 — pgvector
 * rejects NaN/Infinity outright, and one poisoned component must not make a
 * whole record unwritable.
 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

/** `%`/`_`/`\` are LIKE metacharacters; escape them so a query is matched literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** int8 arrives as a string (it overflows a JS number); float8/int4 arrive as numbers. */
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : toNumber(value);
}

function toOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** `float8[]` normally arrives parsed; a driver that hands back `{1,2}` text still decodes. */
function toFloatArray(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return value.map((n) => toNumber(n));
  if (typeof value === 'string') {
    const inner = value
      .replace(/^[{[]/, '')
      .replace(/[}\]]$/, '')
      .trim();
    if (inner === '') return [];
    return inner.split(',').map((n) => Number(n));
  }
  return undefined;
}

/** `jsonb` normally arrives parsed; a driver that hands back text still decodes. */
function toJson(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return value as Record<string, unknown>;
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  const scope: MemoryScope = {};
  for (const [key, column] of Object.entries(MEMORY_SCOPE_COLUMNS)) {
    const value = toOptionalString(row[column]);
    if (value !== undefined) scope[key as keyof MemoryScope] = value;
  }
  const record: MemoryRecord = {
    id: String(row['id']),
    text: String(row['text']),
    hash: String(row['hash']),
    kind: String(row['kind']) as MemoryRecord['kind'],
    scope,
    createdAt: toNumber(row['created_at']),
    updatedAt: toNumber(row['updated_at']),
  };
  const metadata = toJson(row['metadata']);
  if (metadata !== undefined) record.metadata = metadata;
  const importance = toOptionalNumber(row['importance']);
  if (importance !== undefined) record.importance = importance;
  const embeddingModelId = toOptionalString(row['embedding_model_id']);
  if (embeddingModelId !== undefined) record.embeddingModelId = embeddingModelId;
  const lastAccessedAt = toOptionalNumber(row['last_accessed_at']);
  if (lastAccessedAt !== undefined) record.lastAccessedAt = lastAccessedAt;
  const expiresAt = toOptionalNumber(row['expires_at']);
  if (expiresAt !== undefined) record.expiresAt = expiresAt;
  const validAt = toOptionalNumber(row['valid_at']);
  if (validAt !== undefined) record.validAt = validAt;
  const invalidAt = toOptionalNumber(row['invalid_at']);
  if (invalidAt !== undefined) record.invalidAt = invalidAt;
  return record;
}

function memoryValues(record: MemoryRecord): unknown[] {
  return [
    record.id,
    record.text,
    record.hash,
    record.kind,
    record.scope.userId ?? null,
    record.scope.agentId ?? null,
    record.scope.runId ?? null,
    record.scope.actorId ?? null,
    record.scope.chatId ?? null,
    record.importance ?? null,
    record.metadata ? JSON.stringify(record.metadata) : null,
    record.embedding ?? null,
    record.embeddingModelId ?? null,
    record.createdAt,
    record.updatedAt,
    record.lastAccessedAt ?? null,
    record.expiresAt ?? null,
    record.validAt ?? null,
    record.invalidAt ?? null,
  ];
}

/** Unset scope fields do NOT filter — the same rule every backend owes its callers. */
function scopeConditions(
  scope: MemoryScope | undefined,
  columns: Record<string, string>,
  bind: Binder,
): string[] {
  if (!scope) return [];
  const out: string[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = scope[key as keyof MemoryScope];
    if (value !== undefined && value !== null) out.push(`${column} = ${bind.add(value)}`);
  }
  return out;
}

/**
 * Bi-temporal visibility. Without `asOf` a record is visible while it has not
 * been superseded; with it, the question is "what was true THEN": the fact must
 * already have been valid and must not yet have been invalidated. `validAt`
 * falls back to `createdAt`, matching the field's documented default.
 */
function temporalConditions(asOf: number | undefined, bind: Binder): string[] {
  if (asOf === undefined) return ['invalid_at IS NULL'];
  const at = bind.add(asOf);
  return [`COALESCE(valid_at, created_at) <= ${at}`, `(invalid_at IS NULL OR invalid_at > ${at})`];
}

function whereClause(conditions: string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
}

// ===================================================================
// Driver loading
// ===================================================================

interface PgModule {
  Pool?: new (config: { connectionString: string }) => PgPoolLike;
  default?: { Pool?: new (config: { connectionString: string }) => PgPoolLike };
}

/**
 * Lazy `pg` load. `as string` keeps tsup's dts builder from statically resolving
 * the optional peer (same trick the `node:` surfaces use), so a consumer that
 * injects a client never needs `pg` installed at all.
 */
async function createPool(connectionString: string): Promise<PgPoolLike> {
  let mod: PgModule;
  try {
    mod = (await import('pg' as string)) as unknown as PgModule;
  } catch (cause) {
    throw new InvalidRequestError({
      message:
        "createPostgresStores({ connectionString }) needs the optional peer 'pg' (npm i pg). " +
        'Or inject any driver with a `query(sql, params)` method as { client } — a pg.Pool, a ' +
        'pg.Client, a serverless HTTP driver, or your own wrapper.',
      cause,
    });
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) {
    throw new InvalidRequestError({
      message: "The installed 'pg' module exposes no Pool constructor. Inject { client } instead.",
    });
  }
  return new Pool({ connectionString });
}

// ===================================================================
// Factory
// ===================================================================

/**
 * Build the Postgres store pack. Nothing touches the database until the first
 * store call (or an explicit `migrate()`); only the option validation is eager,
 * so a bad schema name fails at construction rather than mid-run.
 */
export function createPostgresStores(options: PostgresStoreOptions): PostgresStores {
  const injected = (options as { client?: PgClientLike }).client;
  const connectionString = (options as { connectionString?: string }).connectionString;
  if (!injected && !connectionString) {
    throw new InvalidRequestError({
      message:
        'createPostgresStores requires either { client } (any object with a `query` method) or ' +
        '{ connectionString }.',
    });
  }

  const schema = validateSchema(options.schema ?? 'public');
  const dimensions = validateDimensions(options.dimensions ?? DEFAULT_DIMENSIONS);
  const vectorMode = options.pgvector ?? 'auto';
  const table = (name: string): string => `${schema}.${name}`;

  let clientPromise: Promise<PgClientLike> | undefined;
  let ownedPool: PgPoolLike | undefined;
  let migration: Promise<void> | undefined;
  let vectorEnabled = false;

  const client = async (): Promise<PgClientLike> => {
    clientPromise ??= injected
      ? Promise.resolve(injected)
      : createPool(connectionString!).then((pool) => {
          ownedPool = pool;
          return pool;
        });
    return clientPromise;
  };

  const exec = async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    const result = await (await client()).query(sql, params);
    return result.rows ?? [];
  };

  // --- migration ------------------------------------------------------------

  const detectVector = async (): Promise<boolean> => {
    if (vectorMode === 'off') return false;
    let rows: Record<string, unknown>[];
    try {
      rows = await exec(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    } catch (cause) {
      if (vectorMode === 'require') {
        throw new InvalidRequestError({
          message:
            "pgvector: 'require' could not probe pg_extension for the 'vector' extension. " +
            "Grant the connection read access to pg_extension, or use pgvector: 'auto'.",
          cause,
        });
      }
      return false;
    }
    if (rows.length > 0) return true;
    if (vectorMode === 'require') {
      throw new InvalidRequestError({
        message:
          "pgvector: 'require' was set but the 'vector' extension is not installed in this " +
          'database. Ask a superuser for `CREATE EXTENSION vector;` (this adapter never runs it ' +
          "itself), or switch to pgvector: 'auto' to fall back to embedding_json + JS cosine.",
      });
    }
    return false;
  };

  /**
   * The declared width of an EXISTING `deuz_memory.embedding` column, or
   * `undefined` when there is none. `atttypmod` is where pgvector keeps a
   * `vector(D)`'s D; `to_regclass` answers NULL (so: no rows) for a table that
   * has not been created yet, which is the normal first-migration case.
   */
  const currentVectorDimensions = async (): Promise<number | undefined> => {
    const rows = await exec(
      `SELECT atttypmod FROM pg_attribute WHERE attrelid = to_regclass($1) ` +
        `AND attname = 'embedding' AND NOT attisdropped`,
      [`${schema}.deuz_memory`],
    );
    const declared = toOptionalNumber(rows[0]?.['atttypmod']);
    return declared !== undefined && declared > 0 ? declared : undefined;
  };

  const runMigration = async (): Promise<void> => {
    vectorEnabled = await detectVector();

    if (vectorEnabled) {
      // `ADD COLUMN IF NOT EXISTS` is a NO-OP against a column that already
      // exists at another width, so a mismatch would migrate "successfully" and
      // then fail every single write. Fail here instead, before any DDL runs.
      const existing = await currentVectorDimensions();
      if (existing !== undefined && existing !== dimensions) {
        throw new InvalidRequestError({
          message:
            `Schema '${schema}' already stores deuz_memory.embedding as vector(${existing}), but ` +
            `this pack was built with dimensions: ${dimensions}. ADD COLUMN IF NOT EXISTS cannot ` +
            `change a column's width, so every write would be rejected by Postgres. Either pass ` +
            `createPostgresStores({ dimensions: ${existing} }) to match the table, or widen it ` +
            `yourself first: ALTER TABLE ${schema}.deuz_memory ALTER COLUMN embedding TYPE ` +
            `vector(${dimensions}) — which re-embeds nothing, so the stored vectors must already ` +
            'have that width.',
        });
      }
    }

    // deuz_meta first and on its own: the version gate has to READ before the
    // rest of the DDL batch runs.
    await exec(
      `CREATE TABLE IF NOT EXISTS ${table('deuz_meta')} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    const metaRows = await exec(
      `SELECT value FROM ${table('deuz_meta')} WHERE key = 'schema_version'`,
    );
    const found = metaRows[0]?.['value'];
    if (found !== undefined && found !== null && Number(found) > Number(SCHEMA_VERSION)) {
      throw new InvalidRequestError({
        message:
          `Schema '${schema}' reports deuz schema_version ${String(found)}, newer than the ${SCHEMA_VERSION} ` +
          'this @deuz-sdk/core understands. Upgrade the SDK rather than downgrading the schema.',
      });
    }

    const statements: string[] = [
      'BEGIN',
      `CREATE TABLE IF NOT EXISTS ${table('deuz_memory')} (
         id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         hash TEXT NOT NULL,
         kind TEXT NOT NULL,
         user_id TEXT,
         agent_id TEXT,
         run_id TEXT,
         actor_id TEXT,
         chat_id TEXT,
         importance DOUBLE PRECISION,
         metadata JSONB,
         embedding_json DOUBLE PRECISION[],
         embedding_model_id TEXT,
         created_at BIGINT NOT NULL,
         updated_at BIGINT NOT NULL,
         last_accessed_at BIGINT,
         expires_at BIGINT,
         valid_at BIGINT,
         invalid_at BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS deuz_memory_scope_idx ON ${table('deuz_memory')} (user_id, agent_id, chat_id)`,
      `CREATE INDEX IF NOT EXISTS deuz_memory_hash_idx ON ${table('deuz_memory')} (hash)`,
      `CREATE INDEX IF NOT EXISTS deuz_memory_expires_idx ON ${table('deuz_memory')} (expires_at) WHERE expires_at IS NOT NULL`,
    ];
    if (vectorEnabled) {
      // The type name is unqualified, so the extension's schema must be on the
      // connection's search_path (it is, when installed into public).
      statements.push(
        `ALTER TABLE ${table('deuz_memory')} ADD COLUMN IF NOT EXISTS embedding vector(${dimensions})`,
        `CREATE INDEX IF NOT EXISTS deuz_memory_embedding_idx ON ${table('deuz_memory')} USING hnsw (embedding vector_cosine_ops)`,
      );
    }
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${table('deuz_chats')} (
         chat_id TEXT PRIMARY KEY,
         user_id TEXT,
         agent_id TEXT,
         run_id TEXT,
         actor_id TEXT,
         scope_chat_id TEXT,
         parent_id TEXT,
         record TEXT NOT NULL,
         updated_at BIGINT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${table('deuz_sessions')} (
         run_id TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         step_index INT NOT NULL,
         checkpoint TEXT NOT NULL,
         created_at BIGINT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${table('deuz_runs')} (
         run_id TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         record JSONB NOT NULL,
         created_at BIGINT NOT NULL,
         updated_at BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS deuz_runs_status_idx ON ${table('deuz_runs')} (status)`,
      // Literals, not placeholders: the batch is a SIMPLE query (multi-statement
      // + implicit transaction), and the extended protocol allows only one
      // statement per message.
      `INSERT INTO ${table('deuz_meta')} (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}') ON CONFLICT (key) DO NOTHING`,
      'COMMIT',
    );

    // ONE query, so BEGIN/COMMIT cannot be split across pooled connections.
    await exec(`${statements.join(';\n')};`);
  };

  const ready = (): Promise<void> => {
    migration ??= runMigration().catch((error: unknown) => {
      migration = undefined; // a transient failure must not poison the pack
      throw error;
    });
    return migration;
  };

  // --- MemoryStore ----------------------------------------------------------

  /**
   * Guard the ONE write Postgres cannot absorb. A `vector(D)` column rejects any
   * other width outright, and an adapter that lets that error surface as a raw
   * driver message (or worse, swallows it) turns "the agent stopped learning"
   * into a condition with no diagnosis. Only meaningful when the vector column
   * exists — `embedding_json DOUBLE PRECISION[]` has no declared width.
   */
  const assertVectorWidth = (embedding: number[], id: string): void => {
    if (!vectorEnabled || embedding.length === dimensions) return;
    throw new InvalidRequestError({
      message:
        `Memory '${id}' carries a ${embedding.length}-dimension embedding, but ` +
        `${schema}.deuz_memory.embedding is vector(${dimensions}), so Postgres would reject the ` +
        `row. Build the pack with createPostgresStores({ dimensions: ${embedding.length} }) (and ` +
        `migrate the column to match), or embed with a model that produces ${dimensions} ` +
        'dimensions. Mixing widths in one table is not possible — pgvector fixes it per column.',
    });
  };

  const upsertMemory = async (records: MemoryRecord[]): Promise<void> => {
    if (records.length === 0) return;
    await ready();
    const columns = [...MEMORY_WRITE_COLUMNS];
    const placeholders = columns.map((_c, i) => `$${i + 1}`);
    if (vectorEnabled) {
      columns.push('embedding' as (typeof MEMORY_WRITE_COLUMNS)[number]);
      placeholders.push(`$${columns.length}::vector`);
    }
    const assignments = columns
      .filter((c) => c !== 'id')
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');
    const sql =
      `INSERT INTO ${table('deuz_memory')} (${columns.join(', ')}) ` +
      `VALUES (${placeholders.join(', ')}) ` +
      `ON CONFLICT (id) DO UPDATE SET ${assignments}`;

    // Width first, for EVERY record: a rejected batch must not have written
    // half of itself before the mismatch surfaced.
    for (const record of records) {
      if (record.embedding) assertVectorWidth(record.embedding, record.id);
    }

    // Per-row statements: each is atomic on its own, and a batch spanning a
    // pool cannot be wrapped in a transaction (see the header note).
    for (const record of records) {
      const values = memoryValues(record);
      if (vectorEnabled) values.push(record.embedding ? toVectorLiteral(record.embedding) : null);
      await exec(sql, values);
    }
  };

  const searchMemory = async (
    query: MemoryQuery,
  ): Promise<{ record: MemoryRecord; score: number }[]> => {
    await ready();
    const topK = query.topK ?? DEFAULT_TOP_K;

    const conditions = (bind: Binder): string[] => {
      const out = [...scopeConditions(query.scope, MEMORY_SCOPE_COLUMNS, bind)];
      if (query.kind) out.push(`kind = ${bind.add(query.kind)}`);
      out.push(...temporalConditions(query.asOf, bind));
      if (query.filter && Object.keys(query.filter).length > 0) {
        out.push(`metadata @> ${bind.add(JSON.stringify(query.filter))}::jsonb`);
      }
      return out;
    };

    /**
     * The rows a vector query would otherwise never see. Every other backend
     * (in-memory reference, SQLite, Redis) SCORES an embedding-less record 0 and
     * still returns it; restricting the candidate set to rows that happen to
     * carry a vector makes the same query answer differently per backend and
     * loses every text-only memory written before an embedder was wired up.
     */
    const unembedded = async (column: string, take: number): Promise<MemoryHit[]> => {
      if (take <= 0) return [];
      const bind = binder();
      const where = [...conditions(bind), `${column} IS NULL`];
      const rows = await exec(
        `SELECT ${MEMORY_READ_COLUMNS} FROM ${table('deuz_memory')}${whereClause(where)} ` +
          `ORDER BY updated_at DESC LIMIT ${bind.add(take)}`,
        bind.params,
      );
      return rows.map((row) => ({ record: rowToMemory(row), score: 0 }));
    };

    // 1. pgvector: the index does the ranking.
    if (query.embedding && vectorEnabled) {
      const bind = binder();
      const vector = bind.add(toVectorLiteral(query.embedding));
      const where = conditions(bind);
      where.push('embedding IS NOT NULL');
      const rows = await exec(
        `SELECT ${MEMORY_READ_COLUMNS}, 1 - (embedding <=> ${vector}::vector) AS score ` +
          `FROM ${table('deuz_memory')}${whereClause(where)} ` +
          `ORDER BY embedding <=> ${vector}::vector LIMIT ${bind.add(topK)}`,
        bind.params,
      );
      const hits = rows.map((row) => ({
        record: rowToMemory(row),
        score: toNumber(row['score']),
      }));
      // A score-0 row can only ever outrank a NEGATIVE cosine, so a full page
      // whose worst hit is >= 0 is already the answer — which keeps the
      // flagship HNSW path at ONE round-trip for real (non-negative) embeddings.
      const worst = hits[hits.length - 1]?.score ?? 0;
      if (hits.length >= topK && worst >= 0) return hits;
      return [...hits, ...(await unembedded('embedding', topK))]
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }

    // 2. No pgvector: pull the freshest candidates and rank them here.
    if (query.embedding) {
      const bind = binder();
      const where = conditions(bind);
      const rows = await exec(
        `SELECT ${MEMORY_READ_COLUMNS}, embedding_json FROM ${table('deuz_memory')}` +
          `${whereClause(where)} ORDER BY updated_at DESC LIMIT ${FALLBACK_CANDIDATE_LIMIT}`,
        bind.params,
      );
      return rows
        .map((row) => {
          const vector = toFloatArray(row['embedding_json']);
          return {
            record: rowToMemory(row),
            score: vector && vector.length > 0 ? cosineSimilarity(query.embedding!, vector) : 0,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }

    // 3. Keyword / plain scope listing.
    const bind = binder();
    const where = conditions(bind);
    if (query.text) where.push(`text ILIKE ${bind.add(likePattern(query.text))}`);
    const rows = await exec(
      `SELECT ${MEMORY_READ_COLUMNS} FROM ${table('deuz_memory')}${whereClause(where)} ` +
        `ORDER BY updated_at DESC LIMIT ${bind.add(topK)}`,
      bind.params,
    );
    return rows.map((row) => ({ record: rowToMemory(row), score: query.text ? 1 : 0 }));
  };

  const memory: Required<MemoryStore> = {
    upsert: upsertMemory,
    async get(id, scope) {
      await ready();
      const bind = binder();
      const where = [`id = ${bind.add(id)}`, ...scopeConditions(scope, MEMORY_SCOPE_COLUMNS, bind)];
      const rows = await exec(
        `SELECT ${MEMORY_READ_COLUMNS} FROM ${table('deuz_memory')}${whereClause(where)} LIMIT 1`,
        bind.params,
      );
      const row = rows[0];
      return row ? rowToMemory(row) : null;
    },
    search: searchMemory,
    async list(scope, opts) {
      await ready();
      const bind = binder();
      const where = [...scopeConditions(scope, MEMORY_SCOPE_COLUMNS, bind), 'invalid_at IS NULL'];
      if (opts?.kind) where.push(`kind = ${bind.add(opts.kind)}`);
      const limit = opts?.limit === undefined ? '' : ` LIMIT ${bind.add(opts.limit)}`;
      const rows = await exec(
        `SELECT ${MEMORY_READ_COLUMNS} FROM ${table('deuz_memory')}${whereClause(where)} ` +
          `ORDER BY updated_at DESC${limit}`,
        bind.params,
      );
      return rows.map(rowToMemory);
    },
    async delete(ids) {
      if (ids.length === 0) return;
      await ready();
      await exec(`DELETE FROM ${table('deuz_memory')} WHERE id = ANY($1)`, [ids]);
    },
    /**
     * Targeted column UPDATE rather than read-modify-write: a round-trip would
     * lose the embedding (the read set omits it by design) and clobber the
     * pgvector column with NULL.
     */
    async update(id, patch) {
      await ready();
      const bind = binder([id]);
      const sets: string[] = [];
      const simple: [keyof MemoryRecord, string][] = [
        ['text', 'text'],
        ['hash', 'hash'],
        ['kind', 'kind'],
        ['importance', 'importance'],
        ['embeddingModelId', 'embedding_model_id'],
        ['createdAt', 'created_at'],
        ['updatedAt', 'updated_at'],
        ['lastAccessedAt', 'last_accessed_at'],
        ['expiresAt', 'expires_at'],
        ['validAt', 'valid_at'],
        ['invalidAt', 'invalid_at'],
      ];
      for (const [key, column] of simple) {
        if (patch[key] !== undefined) sets.push(`${column} = ${bind.add(patch[key] ?? null)}`);
      }
      if (patch.metadata !== undefined) {
        sets.push(`metadata = ${bind.add(JSON.stringify(patch.metadata))}`);
      }
      if (patch.scope !== undefined) {
        for (const [key, column] of Object.entries(MEMORY_SCOPE_COLUMNS)) {
          sets.push(`${column} = ${bind.add(patch.scope[key as keyof MemoryScope] ?? null)}`);
        }
      }
      if (patch.embedding !== undefined) {
        assertVectorWidth(patch.embedding, id);
        sets.push(`embedding_json = ${bind.add(patch.embedding)}`);
        if (vectorEnabled) {
          sets.push(`embedding = ${bind.add(toVectorLiteral(patch.embedding))}::vector`);
        }
      }
      if (sets.length === 0) return;
      await exec(
        `UPDATE ${table('deuz_memory')} SET ${sets.join(', ')} WHERE id = $1`,
        bind.params,
      );
    },
    async findByHash(hashes, scope) {
      if (hashes.length === 0) return [];
      await ready();
      const bind = binder([hashes]);
      const where = [
        'hash = ANY($1)',
        ...scopeConditions(scope, MEMORY_SCOPE_COLUMNS, bind),
        'invalid_at IS NULL',
      ];
      const rows = await exec(
        `SELECT ${MEMORY_READ_COLUMNS} FROM ${table('deuz_memory')}${whereClause(where)} ` +
          `ORDER BY updated_at DESC`,
        bind.params,
      );
      return rows.map(rowToMemory);
    },
    async deleteExpired(now, scope) {
      await ready();
      const bind = binder();
      const where = [
        'expires_at IS NOT NULL',
        `expires_at <= ${bind.add(now)}`,
        ...scopeConditions(scope, MEMORY_SCOPE_COLUMNS, bind),
      ];
      const rows = await exec(
        `DELETE FROM ${table('deuz_memory')}${whereClause(where)} RETURNING id`,
        bind.params,
      );
      return rows.length;
    },
  };

  // --- ChatStore ------------------------------------------------------------

  const CHAT_COLUMNS = [
    'chat_id',
    'user_id',
    'agent_id',
    'run_id',
    'actor_id',
    'scope_chat_id',
    'parent_id',
    'record',
    'updated_at',
  ];

  const chats: Required<ChatStore> = {
    async saveChat(record) {
      await ready();
      const assignments = CHAT_COLUMNS.filter((c) => c !== 'chat_id')
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(', ');
      await exec(
        `INSERT INTO ${table('deuz_chats')} (${CHAT_COLUMNS.join(', ')}) ` +
          `VALUES (${CHAT_COLUMNS.map((_c, i) => `$${i + 1}`).join(', ')}) ` +
          `ON CONFLICT (chat_id) DO UPDATE SET ${assignments}`,
        [
          record.chatId,
          record.scope.userId ?? null,
          record.scope.agentId ?? null,
          record.scope.runId ?? null,
          record.scope.actorId ?? null,
          record.scope.chatId ?? null,
          record.parentId ?? null,
          // Binary-safe codec: raw JSON.stringify would decay Uint8Array parts
          // into { "0": 1, … } objects the adapters cannot send.
          serializeChatRecord(record),
          record.updatedAt,
        ],
      );
    },
    async loadChat(chatId) {
      await ready();
      const rows = await exec(
        `SELECT record FROM ${table('deuz_chats')} WHERE chat_id = $1 LIMIT 1`,
        [chatId],
      );
      const row = rows[0];
      return row ? deserializeChatRecord(String(row['record'])) : undefined;
    },
    async deleteChat(chatId) {
      await ready();
      await exec(`DELETE FROM ${table('deuz_chats')} WHERE chat_id = $1`, [chatId]);
    },
    async listChats(scope) {
      await ready();
      const bind = binder();
      const where = scopeConditions(scope, CHAT_SCOPE_COLUMNS, bind);
      const rows = await exec(
        `SELECT chat_id FROM ${table('deuz_chats')}${whereClause(where)} ORDER BY updated_at DESC`,
        bind.params,
      );
      return rows.map((row) => String(row['chat_id']));
    },
  };

  // --- SessionStore ---------------------------------------------------------

  const sessions: Required<SessionStore> = {
    async save(checkpoint: AgentCheckpoint) {
      await ready();
      await exec(
        `INSERT INTO ${table('deuz_sessions')} (run_id, status, step_index, checkpoint, created_at) ` +
          `VALUES ($1, $2, $3, $4, $5) ` +
          `ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, ` +
          `step_index = EXCLUDED.step_index, checkpoint = EXCLUDED.checkpoint, ` +
          `created_at = EXCLUDED.created_at`,
        [
          checkpoint.runId,
          checkpoint.status,
          checkpoint.stepIndex,
          serializeCheckpoint(checkpoint),
          checkpoint.createdAt,
        ],
      );
    },
    async load(runId) {
      await ready();
      const rows = await exec(
        `SELECT checkpoint FROM ${table('deuz_sessions')} WHERE run_id = $1 LIMIT 1`,
        [runId],
      );
      const row = rows[0];
      return row ? deserializeCheckpoint(String(row['checkpoint'])) : undefined;
    },
    async delete(runId) {
      await ready();
      await exec(`DELETE FROM ${table('deuz_sessions')} WHERE run_id = $1`, [runId]);
    },
    async list() {
      await ready();
      const rows = await exec(
        `SELECT run_id FROM ${table('deuz_sessions')} ORDER BY created_at DESC`,
      );
      return rows.map((row) => String(row['run_id']));
    },
  };

  // --- RunStore -------------------------------------------------------------

  const writeRun = async (record: RunRecord): Promise<void> => {
    await exec(
      `INSERT INTO ${table('deuz_runs')} (run_id, status, record, created_at, updated_at) ` +
        `VALUES ($1, $2, $3, $4, $5) ` +
        `ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, record = EXCLUDED.record, ` +
        `created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [record.runId, record.status, JSON.stringify(record), record.createdAt, record.updatedAt],
    );
  };

  const readRun = async (runId: string): Promise<RunRecord | undefined> => {
    const rows = await exec(`SELECT record FROM ${table('deuz_runs')} WHERE run_id = $1 LIMIT 1`, [
      runId,
    ]);
    const row = rows[0];
    return row ? (toJson(row['record']) as RunRecord | undefined) : undefined;
  };

  const runs: Required<RunStore> = {
    async create(record) {
      await ready();
      await writeRun(record);
    },
    /**
     * Read-modify-write, like `createFileRunStore`: `RunRecord` is stored as one
     * JSONB document, so a partial patch needs the current one. A run's metadata
     * has a single writer (the worker driving it), which is what makes this safe.
     */
    async update(runId, patch) {
      await ready();
      const existing = await readRun(runId);
      if (!existing) return;
      await writeRun({ ...existing, ...patch, runId });
    },
    async get(runId) {
      await ready();
      return readRun(runId);
    },
    async list(filter) {
      await ready();
      const bind = binder();
      const where = filter?.status ? [`status = ${bind.add(filter.status)}`] : [];
      const rows = await exec(
        `SELECT record FROM ${table('deuz_runs')}${whereClause(where)} ORDER BY created_at DESC`,
        bind.params,
      );
      return rows
        .map((row) => toJson(row['record']) as RunRecord | undefined)
        .filter((r): r is RunRecord => r !== undefined);
    },
    async delete(runId) {
      await ready();
      await exec(`DELETE FROM ${table('deuz_runs')} WHERE run_id = $1`, [runId]);
    },
  };

  return {
    memory,
    chats,
    sessions,
    runs,
    migrate: ready,
    async sweepExpiredMemories(now) {
      // Node-only surface: the host clock is the documented default here, the
      // same fallback `simpleCache`/`createApprovalSigner` offer.
      return memory.deleteExpired(now ?? Date.now());
    },
    async close() {
      // A pool opened from `connectionString` is created ASYNCHRONOUSLY (the
      // lazy `import('pg')`), so `ownedPool` is still unset while that is in
      // flight. Closing on the old `ownedPool?.end()` alone therefore released
      // nothing and let the pool land AFTER close — a live connection nobody
      // owns, holding the event loop open. Settle the creation first.
      if (clientPromise) await clientPromise.catch(() => undefined);
      if (ownedPool?.end) await ownedPool.end();
    },
  };
}
