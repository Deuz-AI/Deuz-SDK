/**
 * `@deuz-sdk/core/memory/versioned/postgres` (2.4): the versioned memory store
 * on PostgreSQL (`pg` peer). New tables with their own `deuz_vmem_schema`
 * version table; the legacy pack's tables and migrate versions are untouched.
 * Hybrid search (`tsvector` + vector, RRF) for parity with SQLite; pgvector
 * stays optional, with in-process cosine over a bounded candidate set without
 * it. Each commit pins one pooled connection. Node-only.
 *
 * Concurrency: a commit locks its scope's revision row first, so commits in
 * one scope queue, then reads the receipt, the records it names (locked) and
 * the active generation, plans, and writes, all in one `withPgTransaction`.
 * A unique violation from a writer in another scope that got there first (the
 * same operation id, a record id, the first active generation) runs the
 * transaction again, which then answers replay or conflict. Commits hold a
 * shared advisory lock that `embeddings.activate` takes exclusively, so a
 * generation never switches while a revision is being written.
 *
 * Lexical search uses the `'simple'` text search configuration (no stemming,
 * no stop words), like FTS5's default tokenizer; FTS5 also folds diacritics,
 * `'simple'` does not. Vectors are stored as `real[]`; with pgvector the
 * distance is computed in the database (`<=>`), otherwise the freshest
 * `candidateLimit` candidates are scored here.
 */
import type {
  MemoryEmbeddingGeneration,
  MemoryForgetEvent,
  MemoryReembedItem,
  VersionedMemoryCommit,
  VersionedMemoryCommitResult,
  VersionedMemoryQuery,
  VersionedMemoryReceipt,
  VersionedMemoryRecord,
  VersionedMemoryStore,
} from '../memory/versioned/types';
import type { Clock, Logger } from '../types/deps';
import type { Observer } from '../types/observe';
import type { Sha256Digest } from '../internal/digest';
import { InvalidRequestError } from '../errors';
import type { PostgresConnectionOptions } from './store-connection';
import type { PgClientLike } from './store-postgres';
import { assertPgPool, ensurePgSchema, withPgTransaction, type PgPoolLike } from './pg-tx';
import { SERIALIZATION_CODES } from './postgres-migrate';
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
  fuseHits,
  normalizeScope,
  planCommit,
  pruneOperationsWarning,
  queryTokens,
  rankByCosine,
  replayOrRefuse,
  retentionSpan,
  scopeKey,
  validateCommit,
  validateGeneration,
  type CommitPlan,
  type CommitSnapshot,
  type RecordLookup,
  type ScoredRevision,
} from './vmem-shared';

/** Options of `createPostgresVersionedMemoryStore`. */
export type PostgresVersionedMemoryStoreOptions = PostgresConnectionOptions & {
  /** `'auto'` (default) uses pgvector when installed; `'require'` refuses without it; `'off'` never probes. */
  pgvector?: 'auto' | 'require' | 'off';
  /** Rows scored in process without pgvector. Default 1000. */
  candidateLimit?: number;
  /** The store clock (`recordedAt`, TTL). Default: the host clock. */
  clock?: Clock;
  /** Where `pruneOperations` warns that it gave up dedupe protection. Default: silent. */
  logger?: Logger;
  /** Reports `deuz.memory.op` spans for `pruneHistory` and `pruneOperations`. */
  observer?: Observer;
};

/** A PostgreSQL `VersionedMemoryStore` with an explicit `migrate`. */
export type PostgresVersionedMemoryStore = VersionedMemoryStore & {
  /** Creates or patches the schema; idempotent, memoized, retried after a failure. */
  migrate(): Promise<void>;
  close(): Promise<void>;
};

const FACTORY = 'createPostgresVersionedMemoryStore';
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_CANDIDATE_LIMIT = 1000;
/** Unique violations a concurrent writer causes: the transaction runs again and sees its row. */
const RETRY_ON: readonly string[] = [...SERIALIZATION_CODES, '23505'];

interface PgModule {
  Pool?: new (config: { connectionString: string }) => PgPoolLike;
  default?: { Pool?: new (config: { connectionString: string }) => PgPoolLike };
}

async function openPool(connectionString: string): Promise<PgPoolLike> {
  let mod: PgModule;
  try {
    mod = (await import('pg' as string)) as unknown as PgModule;
  } catch (cause) {
    throw new InvalidRequestError({
      message: `${FACTORY}({ connectionString }) needs the optional peer 'pg' (npm i pg), or pass { pool }.`,
      cause,
    });
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) throw new InvalidRequestError({ message: `${FACTORY}: 'pg' exports no Pool.` });
  return new Pool({ connectionString });
}

function num(value: unknown): number {
  return Number(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function toGeneration(row: Record<string, unknown>): MemoryEmbeddingGeneration {
  return {
    generation: num(row.generation),
    modelId: str(row.model_id),
    dims: num(row.dims),
    status: str(row.status) as MemoryEmbeddingGeneration['status'],
    createdAt: num(row.created_at),
  };
}

function toVector(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string')
    return value
      .replace(/^[{[]|[}\]]$/g, '')
      .split(',')
      .filter((part) => part !== '')
      .map(Number);
  return [];
}

/** Placeholders in order: every value goes through here, never into the SQL text. */
function binder(): { params: unknown[]; add(value: unknown): string } {
  const params: unknown[] = [];
  return {
    params,
    add(value) {
      params.push(value);
      return `$${params.length}`;
    },
  };
}

/** The PostgreSQL versioned memory store (2.4). */
export function createPostgresVersionedMemoryStore(
  options: PostgresVersionedMemoryStoreOptions,
): PostgresVersionedMemoryStore {
  const schema = options.schema ?? 'public';
  if (!SCHEMA_NAME_PATTERN.test(schema) || schema.length > 63)
    throw new TypeError(
      `Invalid Postgres schema name ${JSON.stringify(schema)}: use lower-case letters, digits and underscores.`,
    );
  if ('pool' in options && options.pool) assertPgPool(options.pool, FACTORY);
  const pgvectorMode = options.pgvector ?? 'auto';
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1)
    throw new TypeError(`${FACTORY}: candidateLimit must be a positive integer.`);
  const clock = options.clock ?? HOST_CLOCK;
  const logger = options.logger ?? SILENT_LOGGER;
  const t = (name: string): string => `${schema}.deuz_vmem_${name}`;

  const SCHEMA: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS ${t('records')} (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS deuz_vmem_records_scope_idx ON ${t('records')} (scope_key, id)`,
    `CREATE TABLE IF NOT EXISTS ${t('revisions')} (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      scope_key TEXT NOT NULL,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      text_digest TEXT NOT NULL,
      expires_at BIGINT,
      recorded_at BIGINT NOT NULL,
      operation_id TEXT NOT NULL,
      record TEXT NOT NULL,
      tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
      PRIMARY KEY (id, revision)
    )`,
    `CREATE INDEX IF NOT EXISTS deuz_vmem_revisions_scope_idx ON ${t('revisions')} (scope_key, recorded_at)`,
    `CREATE INDEX IF NOT EXISTS deuz_vmem_revisions_tsv_idx ON ${t('revisions')} USING GIN (tsv)`,
    `CREATE TABLE IF NOT EXISTS ${t('scopes')} (scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${t('receipts')} (
      operation_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      committed_at BIGINT NOT NULL,
      redacted BOOLEAN NOT NULL DEFAULT FALSE,
      receipt TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS deuz_vmem_receipts_time_idx ON ${t('receipts')} (committed_at)`,
    `CREATE TABLE IF NOT EXISTS ${t('receipt_records')} (
      record_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (record_id, operation_id)
    )`,
    `CREATE INDEX IF NOT EXISTS deuz_vmem_receipt_records_op_idx ON ${t('receipt_records')} (operation_id)`,
    `CREATE TABLE IF NOT EXISTS ${t('forgotten')} (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      forgotten_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${t('generations')} (
      generation INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      model_id TEXT NOT NULL,
      dims INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    // At most one active generation: two first vectors racing collide here.
    `CREATE UNIQUE INDEX IF NOT EXISTS deuz_vmem_generations_active_idx ON ${t('generations')} (status) WHERE status = 'active'`,
    `CREATE TABLE IF NOT EXISTS ${t('vectors')} (
      generation INTEGER NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      text_digest TEXT NOT NULL,
      vector REAL[] NOT NULL,
      PRIMARY KEY (generation, id, revision)
    )`,
    `CREATE INDEX IF NOT EXISTS deuz_vmem_vectors_record_idx ON ${t('vectors')} (id, revision)`,
  ];

  let ownedPool: Promise<PgPoolLike> | undefined;
  const pool = (): Promise<PgPoolLike> => {
    if ('pool' in options && options.pool) return Promise.resolve(options.pool);
    ownedPool ??= openPool((options as { connectionString: string }).connectionString);
    ownedPool.catch(() => {
      ownedPool = undefined;
    });
    return ownedPool;
  };

  let pgvector = false;
  let migrating: Promise<void> | undefined;
  let closed = false;
  const migrate = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('The Postgres versioned memory store is closed'));
    migrating ??= (async () => {
      const p = await pool();
      await ensurePgSchema(p, {
        name: VMEM_SCHEMA_NAME,
        version: VMEM_SCHEMA_VERSION,
        schema,
        create: SCHEMA,
      });
      if (pgvectorMode === 'off') return;
      const { rows } = await p.query("SELECT to_regtype('vector') IS NOT NULL AS present");
      pgvector = rows[0]?.present === true || rows[0]?.present === 't';
      if (!pgvector && pgvectorMode === 'require')
        throw new InvalidRequestError({
          message: `${FACTORY}({ pgvector: 'require' }): the vector type is not available. Run CREATE EXTENSION vector, or use 'auto'.`,
        });
    })();
    migrating.catch(() => {
      migrating = undefined;
    });
    return migrating;
  };
  const ready = async (): Promise<PgPoolLike> => {
    await migrate();
    return pool();
  };
  const tx = async <T>(fn: (q: PgClientLike) => Promise<T>): Promise<T> =>
    withPgTransaction(await ready(), fn, { retryOn: RETRY_ON });
  const read = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
    (await (await ready()).query(sql, params)).rows;

  // Commits and activation: commits share the lock, activation takes it alone.
  const lockKey = `deuz-vmem:${schema}`;
  const shareGenerations = (q: PgClientLike) =>
    q.query("SELECT pg_advisory_xact_lock_shared(hashtext('deuz-sdk'), hashtext($1))", [lockKey]);
  const holdGenerations = (q: PgClientLike) =>
    q.query("SELECT pg_advisory_xact_lock(hashtext('deuz-sdk'), hashtext($1))", [lockKey]);

  async function readActive(q: PgClientLike): Promise<MemoryEmbeddingGeneration | undefined> {
    const { rows } = await q.query(`SELECT * FROM ${t('generations')} WHERE status = 'active'`);
    return rows[0] ? toGeneration(rows[0]) : undefined;
  }

  async function readGeneration(
    q: PgClientLike,
    generation: number,
  ): Promise<MemoryEmbeddingGeneration | undefined> {
    const { rows } = await q.query(`SELECT * FROM ${t('generations')} WHERE generation = $1`, [
      generation,
    ]);
    return rows[0] ? toGeneration(rows[0]) : undefined;
  }

  async function readReceipt(
    q: PgClientLike,
    operationId: string,
  ): Promise<VersionedMemoryReceipt | undefined> {
    const { rows } = await q.query(
      `SELECT receipt, redacted FROM ${t('receipts')} WHERE operation_id = $1`,
      [operationId],
    );
    const row = rows[0];
    return row
      ? decodeReceipt(str(row.receipt), row.redacted === true || row.redacted === 't')
      : undefined;
  }

  async function withEmbedding(
    q: PgClientLike,
    records: VersionedMemoryRecord[],
    active: MemoryEmbeddingGeneration | undefined,
  ): Promise<VersionedMemoryRecord[]> {
    if (!active || records.length === 0) return records;
    const { rows } = await q.query(
      `SELECT id, revision, text_digest FROM ${t('vectors')} WHERE generation = $1 AND id = ANY($2)`,
      [active.generation, [...new Set(records.map((r) => r.id))]],
    );
    const digests = new Map(
      rows.map((row) => [`${str(row.id)}\u0000${num(row.revision)}`, str(row.text_digest)]),
    );
    return records.map((record) => {
      if (record.embedding) return record;
      const digest = digests.get(`${record.id}\u0000${record.revision}`);
      return digest
        ? { ...record, embedding: embeddingMeta(active, record.revision, digest as Sha256Digest) }
        : record;
    });
  }

  async function applyPlan(
    q: PgClientLike,
    plan: Extract<CommitPlan, { kind: 'apply' }>,
    active: MemoryEmbeddingGeneration | undefined,
  ): Promise<void> {
    let generation = active?.generation;
    if (plan.generation) {
      const { rows } = await q.query(
        `INSERT INTO ${t('generations')} (model_id, dims, status, created_at) VALUES ($1, $2, 'active', $3) RETURNING generation`,
        [plan.generation.modelId, plan.generation.dims, plan.receipt.committedAt],
      );
      generation = num(rows[0]!.generation);
    }
    for (const [index, record] of plan.revisions.entries()) {
      await q.query(
        `INSERT INTO ${t('revisions')} (id, revision, scope_key, status, kind, text, text_digest, ` +
          'expires_at, recorded_at, operation_id, record) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [
          record.id,
          record.revision,
          plan.scopeKey,
          record.status,
          record.kind,
          record.text,
          plan.textDigests[index],
          record.expiresAt ?? null,
          record.recordedAt,
          record.operationId,
          encodeRecord(record),
        ],
      );
      await q.query(
        `INSERT INTO ${t('records')} (id, scope_key, revision, created_at) VALUES ($1, $2, $3, $4) ` +
          'ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision',
        [record.id, plan.scopeKey, record.revision, record.createdAt],
      );
    }
    for (const carry of plan.carried)
      await q.query(
        `INSERT INTO ${t('vectors')} (generation, id, revision, text_digest, vector) ` +
          `SELECT generation, id, $1, text_digest, vector FROM ${t('vectors')} ` +
          'WHERE id = $2 AND revision = $3 AND text_digest = $4 ON CONFLICT DO NOTHING',
        [carry.toRevision, carry.id, carry.fromRevision, carry.textDigest],
      );
    for (const vector of plan.vectors)
      await q.query(
        `INSERT INTO ${t('vectors')} (generation, id, revision, text_digest, vector) VALUES ($1, $2, $3, $4, $5) ` +
          'ON CONFLICT (generation, id, revision) DO UPDATE SET text_digest = EXCLUDED.text_digest, vector = EXCLUDED.vector',
        [generation, vector.id, vector.revision, vector.textDigest, vector.vector],
      );
    for (const id of new Set(plan.receipt.entries.map((entry) => entry.id)))
      await q.query(
        `INSERT INTO ${t('receipt_records')} (record_id, operation_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, plan.receipt.operationId],
      );
    await q.query(`UPDATE ${t('scopes')} SET revision = $2 WHERE scope_key = $1`, [
      plan.scopeKey,
      plan.receipt.scopeRevision,
    ]);
    await q.query(
      `INSERT INTO ${t('receipts')} (operation_id, request_digest, committed_at, redacted, receipt) VALUES ($1, $2, $3, FALSE, $4)`,
      [
        plan.receipt.operationId,
        plan.receipt.requestDigest,
        plan.receipt.committedAt,
        encodeReceipt(plan.receipt),
      ],
    );
  }

  async function commit(op: VersionedMemoryCommit): Promise<VersionedMemoryCommitResult> {
    validateCommit(op);
    const key = scopeKey(op.scope);
    const ids = commitIds(op);
    return tx(async (q) => {
      // The scope row first: every commit in the scope queues here.
      await q.query(
        `INSERT INTO ${t('scopes')} (scope_key, revision) VALUES ($1, 0) ON CONFLICT (scope_key) DO NOTHING`,
        [key],
      );
      const scopeRows = await q.query(
        `SELECT revision FROM ${t('scopes')} WHERE scope_key = $1 FOR UPDATE`,
        [key],
      );
      await shareGenerations(q);
      const stored = await readReceipt(q, op.operationId);
      if (stored) return replayOrRefuse(op, stored);

      const records = new Map<string, RecordLookup>();
      if (ids.length > 0) {
        const live = await q.query(
          `SELECT c.id, c.scope_key, r.record FROM ${t('records')} c ` +
            `JOIN ${t('revisions')} r ON r.id = c.id AND r.revision = c.revision ` +
            'WHERE c.id = ANY($1) FOR UPDATE OF c',
          [ids],
        );
        for (const row of live.rows)
          records.set(str(row.id), {
            state: 'live',
            scopeKey: str(row.scope_key),
            current: decodeRecord(str(row.record)),
          });
        const gone = await q.query(
          `SELECT id, scope_key FROM ${t('forgotten')} WHERE id = ANY($1)`,
          [ids],
        );
        for (const row of gone.rows)
          if (!records.has(str(row.id)))
            records.set(str(row.id), { state: 'forgotten', scopeKey: str(row.scope_key) });
      }
      const active = await readActive(q);
      const snapshot: CommitSnapshot = {
        scopeRevision: num(scopeRows.rows[0]?.revision ?? 0),
        records,
        active,
      };
      const plan = await planCommit(snapshot, op, clock.now());
      if (plan.kind === 'conflict') return plan.result;
      await applyPlan(q, plan, active);
      return { status: 'committed' as const, receipt: plan.receipt };
    });
  }

  // --- search ------------------------------------------------------------

  interface Candidates {
    joins: string;
    where: string;
  }

  function candidates(
    bind: ReturnType<typeof binder>,
    key: string,
    query: VersionedMemoryQuery,
    now: number,
  ): Candidates {
    let joins = '';
    let where = `r.scope_key = ${bind.add(key)}`;
    if (query.recordedAsOf === undefined) {
      joins = `JOIN ${t('records')} c ON c.id = r.id AND c.revision = r.revision`;
    } else {
      const at = bind.add(query.recordedAsOf);
      where +=
        ` AND r.recorded_at <= ${at} AND r.revision = (SELECT MAX(h.revision) FROM ${t('revisions')} h ` +
        `WHERE h.id = r.id AND h.recorded_at <= ${at})`;
    }
    if (!query.includeRetracted) where += " AND r.status = 'active'";
    if (query.kind !== undefined) where += ` AND r.kind = ${bind.add(query.kind)}`;
    if (!query.includeExpired)
      where += ` AND (r.expires_at IS NULL OR r.expires_at > ${bind.add(now)})`;
    return { joins, where };
  }

  async function lexicalSearch(
    key: string,
    query: VersionedMemoryQuery,
    now: number,
    tokens: string[],
    take: number,
  ): Promise<ScoredRevision[]> {
    if (tokens.length === 0) return [];
    const bind = binder();
    const terms = bind.add(tokens.map((token) => `'${token}'`).join(' | '));
    const c = candidates(bind, key, query, now);
    const rows = await read(
      `SELECT r.record, ts_rank(r.tsv, q.query) AS rank FROM to_tsquery('simple', ${terms}) AS q(query), ` +
        `${t('revisions')} r ${c.joins} WHERE r.tsv @@ q.query AND ${c.where} ` +
        `ORDER BY rank DESC, r.recorded_at DESC, r.id LIMIT ${bind.add(take)}`,
      bind.params,
    );
    const raw = rows.map((row) => ({
      record: decodeRecord(str(row.record)),
      score: num(row.rank),
    }));
    const best = raw[0]?.score ?? 0;
    return raw.map((hit) => ({ record: hit.record, score: best > 0 ? hit.score / best : 1 }));
  }

  async function vectorSearch(
    key: string,
    query: VersionedMemoryQuery,
    now: number,
    active: MemoryEmbeddingGeneration,
    take: number,
  ): Promise<ScoredRevision[]> {
    const vector = query.embedding!.vector;
    const bind = binder();
    const generation = bind.add(active.generation);
    const c = candidates(bind, key, query, now);
    const meta = (row: Record<string, unknown>): VersionedMemoryRecord => {
      const record = decodeRecord(str(row.record));
      return {
        ...record,
        embedding: embeddingMeta(active, record.revision, str(row.text_digest) as Sha256Digest),
      };
    };
    if (pgvector) {
      const q = bind.add(vector);
      const distance = `(v.vector)::vector <=> (${q}::real[])::vector`;
      const rows = await read(
        `SELECT r.record, v.text_digest, 1 - (${distance}) AS score FROM ${t('vectors')} v ` +
          `JOIN ${t('revisions')} r ON r.id = v.id AND r.revision = v.revision ${c.joins} ` +
          `WHERE v.generation = ${generation} AND ${c.where} ` +
          `ORDER BY ${distance}, r.recorded_at DESC, r.id LIMIT ${bind.add(take)}`,
        bind.params,
      );
      return rows.map((row) => ({ record: meta(row), score: num(row.score) }));
    }
    const rows = await read(
      `SELECT r.record, v.text_digest, v.vector FROM ${t('vectors')} v ` +
        `JOIN ${t('revisions')} r ON r.id = v.id AND r.revision = v.revision ${c.joins} ` +
        `WHERE v.generation = ${generation} AND ${c.where} ` +
        `ORDER BY r.recorded_at DESC, r.id LIMIT ${bind.add(candidateLimit)}`,
      bind.params,
    );
    return rankByCosine(
      rows.map((row) => ({ record: meta(row), vector: toVector(row.vector) })),
      vector,
      take,
    );
  }

  const store: PostgresVersionedMemoryStore = {
    migrate,
    commit,

    async get(scope, id, getOptions = {}) {
      const key = scopeKey(scope);
      const p = await ready();
      const { rows } = await p.query(
        `SELECT r.record, r.status FROM ${t('records')} c JOIN ${t('revisions')} r ` +
          'ON r.id = c.id AND r.revision = COALESCE($1::integer, c.revision) WHERE c.id = $2 AND c.scope_key = $3',
        [getOptions.revision ?? null, id, key],
      );
      const row = rows[0];
      if (!row) return undefined;
      if (str(row.status) === 'retracted' && !getOptions.includeRetracted) return undefined;
      const [record] = await withEmbedding(p, [decodeRecord(str(row.record))], await readActive(p));
      return record;
    },

    async search(query) {
      const key = scopeKey(query.scope);
      const p = await ready();
      const topK = query.topK ?? DEFAULT_TOP_K;
      const now = query.now ?? clock.now();
      const active = await readActive(p);
      const byVector = assertQueryVector(active, query.embedding);
      const byText = query.text !== undefined && query.text.trim() !== '';
      if (!byVector && !byText) {
        if (query.embedding) return [];
        const bind = binder();
        const c = candidates(bind, key, query, now);
        const rows = await read(
          `SELECT r.record FROM ${t('revisions')} r ${c.joins} WHERE ${c.where} ` +
            `ORDER BY r.recorded_at DESC, r.id LIMIT ${bind.add(topK)}`,
          bind.params,
        );
        const records = await withEmbedding(
          p,
          rows.map((row) => decodeRecord(str(row.record))),
          active,
        );
        return records.map((record) => ({ record, score: 0, match: 'lexical' as const }));
      }
      const take = byVector && byText ? Math.max(topK, FUSION_WINDOW) : topK;
      const [lexical, vector] = await Promise.all([
        byText ? lexicalSearch(key, query, now, queryTokens(query.text), take) : undefined,
        byVector ? vectorSearch(key, query, now, active!, take) : undefined,
      ]);
      const hits = fuseHits(lexical, vector, topK);
      const records = await withEmbedding(
        p,
        hits.map((hit) => hit.record),
        active,
      );
      return hits.map((hit, index) => ({ ...hit, record: records[index]! }));
    },

    async history(scope, id) {
      const key = scopeKey(scope);
      const p = await ready();
      const { rows } = await p.query(
        `SELECT record FROM ${t('revisions')} WHERE id = $1 AND scope_key = $2 ORDER BY revision`,
        [id, key],
      );
      return withEmbedding(
        p,
        rows.map((row) => decodeRecord(str(row.record))),
        await readActive(p),
      );
    },

    async receipt(operationId) {
      return readReceipt(await ready(), operationId);
    },

    async scopeRevision(scope) {
      const key = scopeKey(scope);
      const rows = await read(`SELECT revision FROM ${t('scopes')} WHERE scope_key = $1`, [key]);
      return rows[0] ? num(rows[0].revision) : 0;
    },

    async forget(scope, id, operationId): Promise<MemoryForgetEvent> {
      const normalized = normalizeScope(scope);
      const key = scopeKey(normalized);
      if (typeof operationId !== 'string' || operationId === '')
        throw new InvalidRequestError({ message: 'forget needs an operationId.' });
      const revisions = await tx(async (q) => {
        await q.query(
          `INSERT INTO ${t('scopes')} (scope_key, revision) VALUES ($1, 0) ON CONFLICT (scope_key) DO NOTHING`,
          [key],
        );
        await q.query(`SELECT revision FROM ${t('scopes')} WHERE scope_key = $1 FOR UPDATE`, [key]);
        const record = await q.query(
          `SELECT scope_key FROM ${t('records')} WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (!record.rows[0] || str(record.rows[0].scope_key) !== key) return [];
        const { rows } = await q.query(
          `SELECT revision FROM ${t('revisions')} WHERE id = $1 ORDER BY revision`,
          [id],
        );
        await q.query(`DELETE FROM ${t('vectors')} WHERE id = $1`, [id]);
        await q.query(`DELETE FROM ${t('revisions')} WHERE id = $1`, [id]);
        await q.query(`DELETE FROM ${t('records')} WHERE id = $1`, [id]);
        await q.query(
          `INSERT INTO ${t('forgotten')} (id, scope_key, operation_id, forgotten_at) VALUES ($1, $2, $3, $4) ` +
            'ON CONFLICT (id) DO UPDATE SET operation_id = EXCLUDED.operation_id, forgotten_at = EXCLUDED.forgotten_at',
          [id, key, operationId, clock.now()],
        );
        await q.query(
          `UPDATE ${t('receipts')} SET redacted = TRUE WHERE operation_id IN ` +
            `(SELECT operation_id FROM ${t('receipt_records')} WHERE record_id = $1)`,
          [id],
        );
        await q.query(`DELETE FROM ${t('receipt_records')} WHERE record_id = $1`, [id]);
        await q.query(`UPDATE ${t('scopes')} SET revision = revision + 1 WHERE scope_key = $1`, [
          key,
        ]);
        return rows.map((row) => num(row.revision));
      });
      return { scope: normalized, recordId: id, revisions, operationId };
    },

    embeddings: {
      async active() {
        return readActive(await ready());
      },

      async begin(request) {
        validateGeneration(request);
        return tx(async (q) => {
          await holdGenerations(q);
          const { rows } = await q.query(
            `SELECT * FROM ${t('generations')} WHERE status = 'pending' AND model_id = $1 AND dims = $2 ` +
              'ORDER BY generation DESC LIMIT 1',
            [request.modelId, request.dims],
          );
          if (rows[0]) return toGeneration(rows[0]);
          const created = await q.query(
            `INSERT INTO ${t('generations')} (model_id, dims, status, created_at) VALUES ($1, $2, 'pending', $3) RETURNING *`,
            [request.modelId, request.dims, clock.now()],
          );
          return toGeneration(created.rows[0]!);
        });
      },

      async pending(generation, pendingOptions): Promise<MemoryReembedItem[]> {
        const limit = pendingOptions?.limit;
        if (!Number.isSafeInteger(limit) || limit! < 1)
          throw new InvalidRequestError({ message: 'embeddings.pending needs a positive limit.' });
        const rows = await read(
          `SELECT r.record, r.text_digest FROM ${t('records')} c ` +
            `JOIN ${t('revisions')} r ON r.id = c.id AND r.revision = c.revision ` +
            `LEFT JOIN ${t('vectors')} v ON v.generation = $1 AND v.id = c.id AND v.revision = c.revision ` +
            'WHERE v.id IS NULL AND c.id COLLATE "C" > $2 ORDER BY c.id COLLATE "C" LIMIT $3',
          [generation, pendingOptions.after ?? '', limit],
        );
        return rows.map((row) => {
          const record = decodeRecord(str(row.record));
          return {
            id: record.id,
            revision: record.revision,
            scope: record.scope,
            text: record.text,
            textDigest: str(row.text_digest) as Sha256Digest,
          };
        });
      },

      async put(generation, vectors) {
        return tx(async (q) => {
          const target = await readGeneration(q, generation);
          if (!target || target.status === 'retired')
            throw new InvalidRequestError({
              message: `Embedding generation ${generation} is not open for vectors.`,
            });
          for (const item of vectors) assertGenerationVector(target, item.vector);
          let stored = 0;
          for (const item of vectors) {
            const { rows } = await q.query(
              `SELECT r.text_digest FROM ${t('records')} c JOIN ${t('revisions')} r ` +
                'ON r.id = c.id AND r.revision = c.revision WHERE c.id = $1 AND c.revision = $2',
              [item.id, item.revision],
            );
            if (!rows[0] || str(rows[0].text_digest) !== item.textDigest) continue;
            await q.query(
              `INSERT INTO ${t('vectors')} (generation, id, revision, text_digest, vector) VALUES ($1, $2, $3, $4, $5) ` +
                'ON CONFLICT (generation, id, revision) DO UPDATE SET text_digest = EXCLUDED.text_digest, vector = EXCLUDED.vector',
              [generation, item.id, item.revision, item.textDigest, item.vector],
            );
            stored++;
          }
          return stored;
        });
      },

      async activate(generation) {
        return tx(async (q) => {
          await holdGenerations(q);
          const target = await readGeneration(q, generation);
          if (!target)
            throw new InvalidRequestError({
              message: `Unknown embedding generation ${generation}.`,
            });
          if (target.status === 'active') return true;
          const { rows } = await q.query(
            `SELECT COUNT(*) AS n FROM ${t('records')} c LEFT JOIN ${t('vectors')} v ` +
              'ON v.generation = $1 AND v.id = c.id AND v.revision = c.revision WHERE v.id IS NULL',
            [generation],
          );
          if (num(rows[0]?.n) > 0) return false;
          await q.query(
            `UPDATE ${t('generations')} SET status = 'retired' WHERE status = 'active'`,
          );
          await q.query(`UPDATE ${t('generations')} SET status = 'active' WHERE generation = $1`, [
            generation,
          ]);
          await q.query(
            `DELETE FROM ${t('vectors')} WHERE generation IN ` +
              `(SELECT generation FROM ${t('generations')} WHERE status = 'retired')`,
          );
          return true;
        });
      },
    },

    async pruneHistory(pruneOptions) {
      const olderThan = pruneOptions?.olderThan;
      if (typeof olderThan !== 'number' || !Number.isFinite(olderThan))
        throw new InvalidRequestError({ message: 'pruneHistory needs olderThan (epoch ms).' });
      const key = pruneOptions.scope ? scopeKey(pruneOptions.scope) : undefined;
      return retentionSpan(options.observer, clock, 'prune-history', () =>
        tx(async (q) => {
          const bind = binder();
          const rows = await q.query(
            `SELECT r.id, r.revision FROM ${t('revisions')} r JOIN ${t('records')} c ON c.id = r.id ` +
              `JOIN ${t('revisions')} cur ON cur.id = c.id AND cur.revision = c.revision ` +
              `WHERE r.revision < c.revision AND r.recorded_at < ${bind.add(olderThan)} ` +
              `AND (cur.status = 'retracted' OR (cur.expires_at IS NOT NULL AND cur.expires_at <= ${bind.add(clock.now())}))` +
              (key ? ` AND c.scope_key = ${bind.add(key)}` : ''),
            bind.params,
          );
          for (const row of rows.rows) {
            await q.query(`DELETE FROM ${t('vectors')} WHERE id = $1 AND revision = $2`, [
              str(row.id),
              num(row.revision),
            ]);
            await q.query(`DELETE FROM ${t('revisions')} WHERE id = $1 AND revision = $2`, [
              str(row.id),
              num(row.revision),
            ]);
          }
          return rows.rows.length;
        }),
      );
    },

    async pruneOperations(pruneOptions) {
      const olderThan = pruneOptions?.olderThan;
      if (typeof olderThan !== 'number' || !Number.isFinite(olderThan))
        throw new InvalidRequestError({ message: 'pruneOperations needs olderThan (epoch ms).' });
      const count = await retentionSpan(options.observer, clock, 'prune-operations', () =>
        tx(async (q) => {
          await q.query(
            `DELETE FROM ${t('receipt_records')} WHERE operation_id IN ` +
              `(SELECT operation_id FROM ${t('receipts')} WHERE committed_at < $1)`,
            [olderThan],
          );
          const { rows } = await q.query(
            `DELETE FROM ${t('receipts')} WHERE committed_at < $1 RETURNING operation_id`,
            [olderThan],
          );
          return rows.length;
        }),
      );
      if (count > 0) logger.warn(pruneOperationsWarning(count), { count });
      return count;
    },

    async close() {
      closed = true;
      const owned = ownedPool;
      ownedPool = undefined;
      if (owned) await (await owned.catch(() => undefined))?.end?.();
    },
  };
  return store;
}
