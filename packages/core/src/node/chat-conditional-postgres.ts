/**
 * The PostgreSQL conditional chat store and transcript index (2.4), published
 * from `@deuz-sdk/core/stores/postgres`: separate tables with a
 * `tsvector` + GIN index and their own `deuz_chat_conditional_schema`
 * version table. A write and its index update share one pinned transaction.
 * Node-only.
 *
 * Every write runs in `withPgTransaction` under a transaction-scoped advisory
 * lock on the chat, so writes of one chat queue while other chats go on: the
 * revision read, the compare, the chat row and the transcript rows commit
 * together. A transaction that loses a serialization race or a unique
 * violation to another writer runs again from the read. The legacy pack's
 * tables and migrate versions are untouched.
 *
 * Lexical search uses the `'simple'` text search configuration (no stemming,
 * no stop words) over the terms the shared transcript rules produce: `body`
 * holds a message's folded terms joined by spaces, so case and diacritics
 * fold as in SQLite FTS5, and the parser never keeps a host, an email, a path
 * or a version as one token the query's terms cannot match. Any query term
 * matching is a hit, ranked by `ts_rank`.
 */
import type { ChatRecord } from '../chat';
import { deserializeChatRecord } from '../chat';
import type { MemoryScope } from '../memory';
import type {
  ChatTombstone,
  ConditionalChatStore,
  ConditionalChatWriteResult,
  TranscriptHit,
  TranscriptIndex,
} from '../types/chat-conditional';
import type { Clock } from '../types/deps';
import { assertTombstoneCutoff } from '../chat-conditional';
import { InvalidRequestError } from '../errors';
import {
  assertExpectedRevision,
  deletedChatError,
  normalizeScore,
  queryTerms,
  resolveSearchOptions,
  scopeMatches,
  textTerms,
  transcriptEntries,
  type ResolvedSearchOptions,
} from '../internal/chat-transcript';
import { bigintCutoff } from './budget-postgres';
import type { PostgresConnectionOptions } from './store-connection';
import type { PgClientLike } from './store-postgres';
import { assertPgPool, ensurePgSchema, withPgTransaction, type PgPoolLike } from './pg-tx';
import { SERIALIZATION_CODES } from './postgres-migrate';
import {
  CHAT_CONDITIONAL_SCHEMA_NAME,
  CHAT_CONDITIONAL_SCHEMA_VERSION,
  SCOPE_COLUMNS,
  encodeMessage,
  encodeRecord,
  hostClock,
  messageOfRow,
  readOfRow,
  revisionOfRow,
  scopeOfRow,
  scopeValues,
} from './chat-conditional-shared';

/** Options of `createPostgresConditionalChatStore`. */
export type PostgresConditionalChatStoreOptions = PostgresConnectionOptions & {
  /** The store clock (`deletedAt`, when a message was first indexed). Default: the host clock. */
  clock?: Clock;
};

/** The conditional chat store with its transcript index. */
export type PostgresConditionalChatStore = ConditionalChatStore & {
  transcript: TranscriptIndex;
  migrate(): Promise<void>;
  close(): Promise<void>;
};

const FACTORY = 'createPostgresConditionalChatStore';
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
/** A writer of the same chat in another transaction that got there first: run it again. */
const RETRY_ON: readonly string[] = [...SERIALIZATION_CODES, '23505'];
/** Transcript rows one INSERT carries. */
const INSERT_BATCH = 100;

type Row = Record<string, unknown>;

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

const SCOPE_LIST = SCOPE_COLUMNS.map(([, column]) => column).join(', ');
const CHAT_COLUMNS = `chat_id, ${SCOPE_LIST}, revision, record, updated_at, deleted_at`;
const TRANSCRIPT_COLUMNS = 't.chat_id, t.message_id, t.position, t.message, t.indexed_at';
const TRANSCRIPT_INSERT_COLUMNS = `chat_id, message_id, position, ${SCOPE_LIST}, body, message, indexed_at`;
const TRANSCRIPT_ARITY = 11;

/** `$1, $2, …` for one row starting after `offset` parameters. */
const placeholders = (offset: number, count: number): string =>
  Array.from({ length: count }, (_, n) => `$${offset + n + 1}`).join(', ');

/** `matchesScope` as SQL: only the fields the caller set become predicates. */
function scopeFilter(scope: MemoryScope | undefined, prefix: string, params: unknown[]): string {
  let sql = '';
  for (const [key, column] of SCOPE_COLUMNS) {
    const value = scope?.[key];
    if (value === undefined) continue;
    params.push(value);
    sql += ` AND ${prefix}${column} = $${params.length}`;
  }
  return sql;
}

const isDeleted = (row: Row | undefined): boolean =>
  row !== undefined && row.deleted_at !== null && row.deleted_at !== undefined;

/** The PostgreSQL conditional chat store (2.4). */
export function createPostgresConditionalChatStore(
  options: PostgresConditionalChatStoreOptions,
): PostgresConditionalChatStore {
  const schema = options.schema ?? 'public';
  if (!SCHEMA_NAME_PATTERN.test(schema) || schema.length > 63)
    throw new TypeError(
      `${FACTORY}: invalid Postgres schema name ${JSON.stringify(schema)}; use lower-case letters, digits and underscores.`,
    );
  const injected = 'pool' in options ? options.pool : undefined;
  if (injected) assertPgPool(injected, FACTORY);
  const connectionString = 'connectionString' in options ? options.connectionString : undefined;
  if (!injected && !connectionString)
    throw new TypeError(`${FACTORY} needs { pool } or { connectionString }.`);
  const clock = options.clock ?? hostClock();

  const chats = `${schema}.deuz_chat_conditional`;
  const transcriptTable = `${schema}.deuz_chat_transcript`;
  const SCHEMA_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS ${chats} (
      chat_id TEXT PRIMARY KEY,
      user_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      actor_id TEXT,
      scope_chat_id TEXT,
      revision BIGINT NOT NULL,
      record TEXT,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS deuz_chat_conditional_scope_idx ON ${chats} (user_id, agent_id, scope_chat_id)`,
    `CREATE INDEX IF NOT EXISTS deuz_chat_conditional_deleted_idx ON ${chats} (deleted_at) WHERE deleted_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${transcriptTable} (
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      actor_id TEXT,
      scope_chat_id TEXT,
      body TEXT NOT NULL,
      tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
      message TEXT NOT NULL,
      indexed_at BIGINT NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    )`,
    `CREATE INDEX IF NOT EXISTS deuz_chat_transcript_tsv_idx ON ${transcriptTable} USING GIN (tsv)`,
    `CREATE INDEX IF NOT EXISTS deuz_chat_transcript_chat_idx ON ${transcriptTable} (chat_id, position)`,
    `CREATE INDEX IF NOT EXISTS deuz_chat_transcript_scope_idx ON ${transcriptTable} (user_id, agent_id, scope_chat_id)`,
  ];

  let opened: Promise<PgPoolLike> | undefined;
  let migrated: Promise<void> | undefined;
  let closed = false;
  const pool = (): Promise<PgPoolLike> => {
    if (closed) return Promise.reject(new Error('The PostgreSQL conditional chat store is closed'));
    if (injected) return Promise.resolve(injected);
    opened ??= openPool(connectionString!);
    opened.catch(() => {
      opened = undefined;
    });
    return opened;
  };
  const migrate = async (): Promise<void> => {
    const target = await pool();
    migrated ??= ensurePgSchema(target, {
      name: CHAT_CONDITIONAL_SCHEMA_NAME,
      version: CHAT_CONDITIONAL_SCHEMA_VERSION,
      schema,
      create: SCHEMA_STATEMENTS,
    }).then(() => undefined);
    // A failed migration is retried by the next call.
    migrated.catch(() => {
      migrated = undefined;
    });
    return migrated;
  };
  /** Statements outside a transaction, after the schema is in place. */
  const read = async (): Promise<PgClientLike> => {
    await migrate();
    return pool();
  };
  /** One write transaction under the chat's advisory lock; it may run again. */
  const write = async <T>(chatId: string, fn: (tx: PgClientLike, now: number) => Promise<T>) => {
    await migrate();
    return withPgTransaction(
      await pool(),
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
          'deuz-chat-conditional',
          `${schema}:${chatId}`,
        ]);
        return fn(tx, clock.now());
      },
      { retryOn: RETRY_ON },
    );
  };

  const chatRow = async (q: PgClientLike, chatId: string): Promise<Row | undefined> =>
    (await q.query(`SELECT ${CHAT_COLUMNS} FROM ${chats} WHERE chat_id = $1`, [chatId])).rows[0];

  const upsertChat = (
    tx: PgClientLike,
    chatId: string,
    scope: MemoryScope,
    revision: number,
    record: string | null,
    updatedAt: number,
    deletedAt: number | null,
  ) =>
    tx.query(
      `INSERT INTO ${chats} (${CHAT_COLUMNS}) VALUES (${placeholders(0, 10)}) ` +
        'ON CONFLICT (chat_id) DO UPDATE SET user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id, ' +
        'run_id = EXCLUDED.run_id, actor_id = EXCLUDED.actor_id, scope_chat_id = EXCLUDED.scope_chat_id, ' +
        'revision = EXCLUDED.revision, record = EXCLUDED.record, updated_at = EXCLUDED.updated_at, ' +
        'deleted_at = EXCLUDED.deleted_at',
      [chatId, ...scopeValues(scope), revision, record, updatedAt, deletedAt],
    );

  /** Replaces a chat's transcript rows; a message id indexed before keeps its first time. */
  const indexRecord = async (tx: PgClientLike, record: ChatRecord, now: number) => {
    const { rows } = await tx.query(
      `SELECT message_id, indexed_at FROM ${transcriptTable} WHERE chat_id = $1`,
      [record.chatId],
    );
    const firstIndexed = new Map(
      rows.map((row) => [String(row.message_id), Number(row.indexed_at)]),
    );
    await tx.query(`DELETE FROM ${transcriptTable} WHERE chat_id = $1`, [record.chatId]);
    const scope = scopeValues(record.scope);
    const entries = transcriptEntries(record);
    for (let start = 0; start < entries.length; start += INSERT_BATCH) {
      const batch = entries.slice(start, start + INSERT_BATCH);
      const params: unknown[] = [];
      const values = batch.map((entry, n) => {
        params.push(
          record.chatId,
          entry.messageId,
          entry.index,
          ...scope,
          // The shared terms, not the text: Postgres's parser would keep
          // `api.example.com` or `/srv/app` whole, out of reach of a query term.
          textTerms(entry.text).join(' '),
          encodeMessage(entry.message),
          firstIndexed.get(entry.messageId) ?? now,
        );
        return `(${placeholders(n * TRANSCRIPT_ARITY, TRANSCRIPT_ARITY)})`;
      });
      await tx.query(
        `INSERT INTO ${transcriptTable} (${TRANSCRIPT_INSERT_COLUMNS}) VALUES ${values.join(', ')}`,
        params,
      );
    }
  };

  const unindexChat = (tx: PgClientLike, chatId: string) =>
    tx.query(`DELETE FROM ${transcriptTable} WHERE chat_id = $1`, [chatId]);

  const putChat = async (tx: PgClientLike, record: ChatRecord, revision: number, now: number) => {
    const encoded = encodeRecord(record);
    await upsertChat(tx, record.chatId, record.scope, revision, encoded, record.updatedAt, null);
    await indexRecord(tx, record, now);
    return { ...deserializeChatRecord(encoded), revision };
  };

  const buryChat = async (
    tx: PgClientLike,
    chatId: string,
    row: Row | undefined,
    revision: number,
    now: number,
  ): Promise<ChatTombstone> => {
    const scope = row ? scopeOfRow(row) : {};
    await upsertChat(tx, chatId, scope, revision, null, now, now);
    await unindexChat(tx, chatId);
    return { chatId, scope, revision, deletedAt: now };
  };

  const surrounding = async (q: PgClientLike, row: Row, around: number) => {
    const params = [String(row.chat_id), Number(row.position), around];
    const before = await q.query(
      `SELECT ${TRANSCRIPT_COLUMNS} FROM ${transcriptTable} t WHERE t.chat_id = $1 AND t.position < $2 ORDER BY t.position DESC LIMIT $3`,
      params,
    );
    const after = await q.query(
      `SELECT ${TRANSCRIPT_COLUMNS} FROM ${transcriptTable} t WHERE t.chat_id = $1 AND t.position > $2 ORDER BY t.position ASC LIMIT $3`,
      params,
    );
    return [...before.rows.reverse(), ...after.rows].map(messageOfRow);
  };

  const search = async (
    q: PgClientLike,
    scope: MemoryScope,
    terms: string[],
    resolved: ResolvedSearchOptions,
  ): Promise<TranscriptHit[]> => {
    const params: unknown[] = [terms.map((term) => `"${term}"`).join(' or ')];
    let where = scopeFilter(scope, 't.', params);
    if (resolved.chatIds) {
      params.push(JSON.stringify([...resolved.chatIds]));
      where += ` AND t.chat_id IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`;
    }
    if (resolved.before !== undefined) {
      params.push(resolved.before);
      where += ` AND t.indexed_at < $${params.length}`;
    }
    if (resolved.after !== undefined) {
      params.push(resolved.after);
      where += ` AND t.indexed_at > $${params.length}`;
    }
    params.push(resolved.limit);
    const { rows } = await q.query(
      `SELECT ${TRANSCRIPT_COLUMNS}, ts_rank(t.tsv, q) AS lexical_rank ` +
        `FROM ${transcriptTable} t, websearch_to_tsquery('simple', $1) q ` +
        `WHERE t.tsv @@ q${where} ` +
        `ORDER BY lexical_rank DESC, t.indexed_at DESC, t.chat_id COLLATE "C", t.position LIMIT $${params.length}`,
      params,
    );
    const best = Number(rows[0]?.lexical_rank ?? 0);
    const hits: TranscriptHit[] = [];
    for (const row of rows) {
      const hit: TranscriptHit = {
        ...messageOfRow(row),
        score: normalizeScore(Number(row.lexical_rank), best),
      };
      if (resolved.around > 0) hit.around = await surrounding(q, row, resolved.around);
      hits.push(hit);
    }
    return hits;
  };

  const transcript: TranscriptIndex = {
    async index(record) {
      await write(record.chatId, async (tx, now) => {
        // A backfill never brings a deleted chat back into search.
        if (!isDeleted(await chatRow(tx, record.chatId))) await indexRecord(tx, record, now);
      });
    },

    async remove(chatId) {
      await write(chatId, async (tx) => {
        await unindexChat(tx, chatId);
      });
    },

    async search(scope, query, searchOptions) {
      const resolved = resolveSearchOptions(searchOptions);
      const terms = queryTerms(query);
      if (terms.length === 0 || resolved.limit === 0) return [];
      return search(await read(), scope, terms, resolved);
    },

    async resolveSource(scope, ref) {
      if (ref.chatId === undefined || ref.messageId === undefined) return undefined;
      const q = await read();
      const { rows } = await q.query(
        `SELECT ${TRANSCRIPT_COLUMNS}, ${SCOPE_COLUMNS.map(([, column]) => `t.${column}`).join(', ')} ` +
          `FROM ${transcriptTable} t WHERE t.chat_id = $1 AND t.message_id = $2`,
        [ref.chatId, ref.messageId],
      );
      const row = rows[0];
      return row && scopeMatches(scopeOfRow(row), scope) ? messageOfRow(row) : undefined;
    },
  };

  return {
    conditional: true,
    transcript,
    migrate,

    async readChat(chatId) {
      return readOfRow(await chatRow(await read(), chatId), chatId);
    },

    async writeChat(record, { expectedRevision }) {
      assertExpectedRevision('writeChat', expectedRevision);
      return write(record.chatId, async (tx, now): Promise<ConditionalChatWriteResult> => {
        const row = await chatRow(tx, record.chatId);
        if (isDeleted(row) || revisionOfRow(row) !== expectedRevision)
          return { status: 'conflict', current: readOfRow(row, record.chatId) };
        return {
          status: 'committed',
          record: await putChat(tx, record, expectedRevision + 1, now),
        };
      });
    },

    async tombstoneChat(chatId, { expectedRevision }) {
      assertExpectedRevision('tombstoneChat', expectedRevision);
      return write(chatId, async (tx, now): Promise<ConditionalChatWriteResult> => {
        const row = await chatRow(tx, chatId);
        if (isDeleted(row) || revisionOfRow(row) !== expectedRevision)
          return { status: 'conflict', current: readOfRow(row, chatId) };
        return {
          status: 'deleted',
          tombstone: await buryChat(tx, chatId, row, expectedRevision + 1, now),
        };
      });
    },

    async saveChat(record) {
      await write(record.chatId, async (tx, now) => {
        const row = await chatRow(tx, record.chatId);
        if (isDeleted(row)) throw deletedChatError(record.chatId, revisionOfRow(row));
        await putChat(tx, record, revisionOfRow(row) + 1, now);
      });
    },

    async loadChat(chatId) {
      const current = readOfRow(await chatRow(await read(), chatId), chatId);
      return current.status === 'found' ? current.record : undefined;
    },

    async deleteChat(chatId) {
      await write(chatId, async (tx, now) => {
        const row = await chatRow(tx, chatId);
        if (!isDeleted(row)) await buryChat(tx, chatId, row, revisionOfRow(row) + 1, now);
      });
    },

    async listChats(scope) {
      const params: unknown[] = [];
      const where = scopeFilter(scope, '', params);
      const { rows } = await (
        await read()
      ).query(
        `SELECT chat_id FROM ${chats} WHERE deleted_at IS NULL${where} ` +
          'ORDER BY updated_at DESC, chat_id COLLATE "C" ASC',
        params,
      );
      return rows.map((row) => String(row.chat_id));
    },

    async pruneTombstones(before) {
      assertTombstoneCutoff(before);
      const { rows } = await (
        await read()
      ).query(
        `DELETE FROM ${chats} WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING chat_id`,
        // Whole milliseconds in a bigint column: a fractional cutoff binds as its ceiling.
        [bigintCutoff(before)],
      );
      return rows.length;
    },

    async close() {
      if (closed) return;
      closed = true;
      const own = opened;
      opened = undefined;
      if (own) await (await own.catch(() => undefined))?.end?.();
    },
  };
}
