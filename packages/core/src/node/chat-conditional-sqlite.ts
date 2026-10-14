/**
 * The SQLite conditional chat store and transcript index (2.4), published from
 * `@deuz-sdk/core/stores/sqlite`. Separate tables (chats with revisions,
 * tombstones, an FTS5 transcript index) with their own
 * `deuz_chat_conditional_schema` version table; `deuz_chats` and
 * `PRAGMA user_version` are never touched. A write and its index update are
 * one transaction. Node-only.
 *
 * Every write is one synchronous `BEGIN IMMEDIATE` transaction: it reads the
 * stored revision, compares, writes the chat row and replaces the chat's
 * transcript rows, so processes sharing the file queue on the write lock and a
 * compare-and-set can never interleave.
 *
 * FTS5 is optional per process (Node 22.14's SQLite ships without it): a
 * process without it searches with LIKE and marks the index stale on every
 * write, and the next process with FTS5 rebuilds it before using it. The FTS5
 * index is kept by explicit statements, never triggers, so a process without
 * FTS5 can still write.
 */
import type { ChatRecord } from '../chat';
import type { MemoryScope } from '../memory';
import type {
  ChatTombstone,
  ConditionalChatRecord,
  ConditionalChatStore,
  ConditionalChatWriteResult,
  TranscriptHit,
  TranscriptIndex,
} from '../types/chat-conditional';
import type { Clock } from '../types/deps';
import {
  assertExpectedRevision,
  compareRanked,
  deletedChatError,
  normalizeScore,
  queryTerms,
  resolveSearchOptions,
  scopeMatches,
  transcriptEntries,
  type RankedMessage,
  type ResolvedSearchOptions,
} from '../internal/chat-transcript';
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
  CHAT_CONDITIONAL_SCHEMA_NAME,
  CHAT_CONDITIONAL_SCHEMA_VERSION,
  LIKE_SCAN_LIMIT,
  SCOPE_COLUMNS,
  encodeMessage,
  encodeRecord,
  escapeLike,
  hostClock,
  messageOfRow,
  readOfRow,
  revisionOfRow,
  scopeOfRow,
  scopeValues,
} from './chat-conditional-shared';

/** Options of `createSqliteConditionalChatStore`. */
export type SqliteConditionalChatStoreOptions = SqliteConnectionOptions & {
  /** Build the FTS5 index. Default true, with a LIKE fallback. */
  fts?: boolean;
  clock?: Clock;
};

/** The conditional chat store with its transcript index. */
export type SqliteConditionalChatStore = ConditionalChatStore & {
  transcript: TranscriptIndex;
  close(): Promise<void>;
};

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

const SCOPE_LIST = SCOPE_COLUMNS.map(([, column]) => column).join(', ');

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS deuz_chat_conditional (
    chat_id TEXT PRIMARY KEY,
    user_id TEXT,
    agent_id TEXT,
    run_id TEXT,
    actor_id TEXT,
    scope_chat_id TEXT,
    revision INTEGER NOT NULL,
    record TEXT,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_chat_conditional_scope_idx ON deuz_chat_conditional (user_id, agent_id, scope_chat_id)',
  'CREATE INDEX IF NOT EXISTS deuz_chat_conditional_deleted_idx ON deuz_chat_conditional (deleted_at)',
  `CREATE TABLE IF NOT EXISTS deuz_chat_transcript (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    user_id TEXT,
    agent_id TEXT,
    run_id TEXT,
    actor_id TEXT,
    scope_chat_id TEXT,
    body TEXT NOT NULL,
    message TEXT NOT NULL,
    indexed_at INTEGER NOT NULL,
    UNIQUE (chat_id, message_id)
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_chat_transcript_chat_idx ON deuz_chat_transcript (chat_id, position)',
  'CREATE INDEX IF NOT EXISTS deuz_chat_transcript_scope_idx ON deuz_chat_transcript (user_id, agent_id, scope_chat_id)',
  'CREATE TABLE IF NOT EXISTS deuz_chat_conditional_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

const FTS_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS deuz_chat_transcript_fts
  USING fts5(body, content='deuz_chat_transcript', content_rowid='seq')`;

const FTS_DIRTY = 'fts_dirty';

interface State {
  db: SqliteDatabaseLike;
  statement: SqliteStatementCache;
  /** Lexical search runs on FTS5; false means LIKE. */
  fts: boolean;
}

function all(s: State, sql: string, params: SqlValue[] = []): Row[] {
  return s.statement(s.db, sql).all(...params) as Row[];
}

function one(s: State, sql: string, params: SqlValue[] = []): Row | undefined {
  return s.statement(s.db, sql).get(...params) as Row | undefined;
}

function run(s: State, sql: string, params: SqlValue[] = []): number {
  const result = s.statement(s.db, sql).run(...params) as { changes?: number | bigint } | undefined;
  return Number(result?.changes ?? 0);
}

// --- the FTS index -------------------------------------------------------

/** Builds the index in its own transaction; false when this SQLite has no FTS5. */
function setupFts(s: State): boolean {
  try {
    const existed = one(
      s,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deuz_chat_transcript_fts'",
    );
    sqliteTransaction(s.db, () => {
      s.db.exec(FTS_TABLE);
      if (!existed)
        s.db.exec(
          "INSERT INTO deuz_chat_transcript_fts(deuz_chat_transcript_fts) VALUES('rebuild')",
        );
    });
    all(
      s,
      'SELECT rowid FROM deuz_chat_transcript_fts WHERE deuz_chat_transcript_fts MATCH ? LIMIT 1',
      ['"deuz"'],
    );
    s.fts = true;
    syncFts(s, false);
    return true;
  } catch {
    s.fts = false;
    return false;
  }
}

/**
 * Rebuilds the index when a process without FTS5 wrote since: before a
 * search, and inside every write transaction before it touches the index (a
 * delete for a row the index never saw would corrupt it).
 */
function syncFts(s: State, inTransaction: boolean): void {
  if (!s.fts) return;
  if (!one(s, 'SELECT value FROM deuz_chat_conditional_state WHERE key = ?', [FTS_DIRTY])) return;
  const rebuild = () => {
    s.db.exec("INSERT INTO deuz_chat_transcript_fts(deuz_chat_transcript_fts) VALUES('rebuild')");
    run(s, 'DELETE FROM deuz_chat_conditional_state WHERE key = ?', [FTS_DIRTY]);
  };
  if (inTransaction) rebuild();
  else sqliteTransaction(s.db, rebuild);
}

/** Drops a chat's transcript rows, from the FTS5 index first. In a write transaction. */
function unindexChat(s: State, chatId: string): void {
  syncFts(s, true);
  if (s.fts)
    run(
      s,
      "INSERT INTO deuz_chat_transcript_fts(deuz_chat_transcript_fts, rowid, body) SELECT 'delete', seq, body FROM deuz_chat_transcript WHERE chat_id = ?",
      [chatId],
    );
  run(s, 'DELETE FROM deuz_chat_transcript WHERE chat_id = ?', [chatId]);
  markWritten(s);
}

/**
 * Replaces a chat's transcript rows. A message id indexed before keeps the
 * time it was first indexed. In a write transaction.
 */
function indexRecord(s: State, record: ChatRecord, now: number): void {
  const firstIndexed = new Map(
    all(s, 'SELECT message_id, indexed_at FROM deuz_chat_transcript WHERE chat_id = ?', [
      record.chatId,
    ]).map((row) => [String(row.message_id), Number(row.indexed_at)]),
  );
  unindexChat(s, record.chatId);
  const scope = scopeValues(record.scope);
  for (const entry of transcriptEntries(record))
    run(
      s,
      `INSERT INTO deuz_chat_transcript (chat_id, message_id, position, ${SCOPE_LIST}, body, message, indexed_at) ` +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        record.chatId,
        entry.messageId,
        entry.index,
        ...scope,
        entry.text,
        encodeMessage(entry.message),
        firstIndexed.get(entry.messageId) ?? now,
      ],
    );
  if (s.fts)
    run(
      s,
      'INSERT INTO deuz_chat_transcript_fts(rowid, body) SELECT seq, body FROM deuz_chat_transcript WHERE chat_id = ?',
      [record.chatId],
    );
}

/** After a write without FTS5: the next process with it rebuilds the index. */
function markWritten(s: State): void {
  if (!s.fts)
    run(s, 'INSERT OR REPLACE INTO deuz_chat_conditional_state (key, value) VALUES (?, ?)', [
      FTS_DIRTY,
      '1',
    ]);
}

// --- chats ----------------------------------------------------------------

const CHAT_COLUMNS = `chat_id, ${SCOPE_LIST}, revision, record, updated_at, deleted_at`;

function chatRow(s: State, chatId: string): Row | undefined {
  return one(s, `SELECT ${CHAT_COLUMNS} FROM deuz_chat_conditional WHERE chat_id = ?`, [chatId]);
}

const UPSERT_CHAT =
  `INSERT INTO deuz_chat_conditional (${CHAT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
  'ON CONFLICT (chat_id) DO UPDATE SET user_id = excluded.user_id, agent_id = excluded.agent_id, ' +
  'run_id = excluded.run_id, actor_id = excluded.actor_id, scope_chat_id = excluded.scope_chat_id, ' +
  'revision = excluded.revision, record = excluded.record, updated_at = excluded.updated_at, ' +
  'deleted_at = excluded.deleted_at';

/** Writes `record` at `revision` and indexes it. In a write transaction. */
function putChat(s: State, record: ChatRecord, revision: number, now: number): void {
  run(s, UPSERT_CHAT, [
    record.chatId,
    ...scopeValues(record.scope),
    revision,
    encodeRecord(record),
    record.updatedAt,
    null,
  ]);
  indexRecord(s, record, now);
}

/** Replaces the chat by a tombstone at `revision`. In a write transaction. */
function buryChat(s: State, chatId: string, row: Row | undefined, revision: number, now: number) {
  const scope: MemoryScope = row ? scopeOfRow(row) : {};
  run(s, UPSERT_CHAT, [chatId, ...scopeValues(scope), revision, null, now, now]);
  unindexChat(s, chatId);
  const tombstone: ChatTombstone = { chatId, scope, revision, deletedAt: now };
  return tombstone;
}

/** The live record just written, as a read returns it. In the write transaction. */
function storedRecord(s: State, chatId: string): ConditionalChatRecord {
  const read = readOfRow(chatRow(s, chatId), chatId);
  if (read.status !== 'found') throw new Error(`chat '${chatId}' vanished inside its own write`);
  return read.record;
}

const isDeleted = (row: Row | undefined): boolean =>
  row !== undefined && row.deleted_at !== null && row.deleted_at !== undefined;

/** `matchesScope` as SQL: only the fields the caller set become predicates. */
function scopeFilter(scope: MemoryScope | undefined, prefix: string) {
  let sql = '';
  const params: SqlValue[] = [];
  for (const [key, column] of SCOPE_COLUMNS) {
    const value = scope?.[key];
    if (value === undefined) continue;
    sql += ` AND ${prefix}${column} = ?`;
    params.push(value);
  }
  return { sql, params };
}

// --- search ---------------------------------------------------------------

const TRANSCRIPT_COLUMNS = `t.seq, t.chat_id, t.message_id, t.position, t.body, t.message, t.indexed_at`;

function searchWhere(scope: MemoryScope, options: ResolvedSearchOptions) {
  const scoped = scopeFilter(scope, 't.');
  let sql = `1 = 1${scoped.sql}`;
  const params: SqlValue[] = [...scoped.params];
  if (options.chatIds) {
    sql += ' AND t.chat_id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify([...options.chatIds]));
  }
  if (options.before !== undefined) {
    sql += ' AND t.indexed_at < ?';
    params.push(options.before);
  }
  if (options.after !== undefined) {
    sql += ' AND t.indexed_at > ?';
    params.push(options.after);
  }
  return { sql, params };
}

type RankedRow = RankedMessage & { row: Row };

function rankedOf(row: Row, raw: number): RankedRow {
  return {
    chatId: String(row.chat_id),
    index: Number(row.position),
    indexedAt: Number(row.indexed_at),
    raw,
    row,
  };
}

/** Substring matching, ranked here by how many terms a message holds: the fallback. */
function likeSearch(
  s: State,
  terms: string[],
  where: { sql: string; params: SqlValue[] },
): RankedRow[] {
  const any = terms.map(() => "t.body LIKE ? ESCAPE '\\'").join(' OR ');
  const rows = all(
    s,
    `SELECT ${TRANSCRIPT_COLUMNS} FROM deuz_chat_transcript t WHERE ${where.sql} AND (${any}) ` +
      'ORDER BY t.indexed_at DESC, t.chat_id, t.position LIMIT ?',
    [...where.params, ...terms.map((term) => `%${escapeLike(term)}%`), LIKE_SCAN_LIMIT],
  );
  return rows
    .map((row) => rankedOf(row, terms.filter((term) => String(row.body).includes(term)).length))
    .sort(compareRanked);
}

/** FTS5 with bm25 (negative: better is lower), any term matching. */
function ftsSearch(
  s: State,
  terms: string[],
  where: { sql: string; params: SqlValue[] },
  limit: number,
): RankedRow[] {
  const rows = all(
    s,
    `SELECT ${TRANSCRIPT_COLUMNS}, bm25(deuz_chat_transcript_fts) AS lexical_rank FROM deuz_chat_transcript_fts ` +
      'JOIN deuz_chat_transcript t ON t.seq = deuz_chat_transcript_fts.rowid ' +
      `WHERE deuz_chat_transcript_fts MATCH ? AND ${where.sql} ` +
      'ORDER BY lexical_rank, t.indexed_at DESC, t.chat_id, t.position LIMIT ?',
    [terms.map((term) => `"${term}"`).join(' OR '), ...where.params, limit],
  );
  return rows.map((row) => rankedOf(row, -Number(row.lexical_rank)));
}

function surrounding(s: State, row: Row, around: number) {
  const params = [String(row.chat_id), Number(row.position), around];
  const before = all(
    s,
    `SELECT ${TRANSCRIPT_COLUMNS} FROM deuz_chat_transcript t WHERE t.chat_id = ? AND t.position < ? ORDER BY t.position DESC LIMIT ?`,
    params,
  ).reverse();
  const after = all(
    s,
    `SELECT ${TRANSCRIPT_COLUMNS} FROM deuz_chat_transcript t WHERE t.chat_id = ? AND t.position > ? ORDER BY t.position ASC LIMIT ?`,
    params,
  );
  return [...before, ...after].map(messageOfRow);
}

function search(s: State, scope: MemoryScope, terms: string[], options: ResolvedSearchOptions) {
  const where = searchWhere(scope, options);
  let ranked: RankedRow[];
  if (s.fts) {
    syncFts(s, false);
    try {
      ranked = ftsSearch(s, terms, where, options.limit);
    } catch {
      // A query the index will not take is a query-level problem: LIKE answers it.
      ranked = likeSearch(s, terms, where);
    }
  } else ranked = likeSearch(s, terms, where);
  const best = ranked[0]?.raw ?? 0;
  return ranked.slice(0, options.limit).map((entry): TranscriptHit => {
    const hit: TranscriptHit = {
      ...messageOfRow(entry.row),
      score: normalizeScore(entry.raw, best),
    };
    if (options.around > 0) hit.around = surrounding(s, entry.row, options.around);
    return hit;
  });
}

// --- the store ------------------------------------------------------------

/** The SQLite conditional chat store (2.4). */
export function createSqliteConditionalChatStore(
  options: SqliteConditionalChatStoreOptions,
): SqliteConditionalChatStore {
  const clock = options.clock ?? hostClock();
  const connection = createSqliteConnection<State>(
    options.database
      ? { path: ':memory:', database: options.database, wal: false }
      : { path: options.path, wal: options.wal },
    {
      injected: 'borrowed',
      unavailable: sqliteUnavailableMessage('createSqliteConditionalChatStore'),
      closedMessage: 'The SQLite conditional chat store is closed',
      setup(db) {
        ensureSqliteSchema(db, {
          name: CHAT_CONDITIONAL_SCHEMA_NAME,
          version: CHAT_CONDITIONAL_SCHEMA_VERSION,
          create: SCHEMA,
        });
        const state: State = { db, statement: createSqliteStatementCache(), fts: false };
        if (options.fts !== false) setupFts(state);
        return state;
      },
    },
  );
  /** One write transaction, synchronous from BEGIN to COMMIT. */
  const write = <T>(fn: (s: State, now: number) => T): Promise<T> =>
    connection.use((s) => sqliteTransaction(s.db, () => fn(s, clock.now())));

  const transcript: TranscriptIndex = {
    index(record) {
      return write((s, now) => {
        // A backfill never brings a deleted chat back into search.
        if (!isDeleted(chatRow(s, record.chatId))) indexRecord(s, record, now);
      });
    },

    remove(chatId) {
      return write((s) => unindexChat(s, chatId));
    },

    async search(scope, query, searchOptions) {
      const resolved = resolveSearchOptions(searchOptions);
      const terms = queryTerms(query);
      if (terms.length === 0 || resolved.limit === 0) return [];
      return connection.use((s) => search(s, scope, terms, resolved));
    },

    async resolveSource(scope, ref) {
      if (ref.chatId === undefined || ref.messageId === undefined) return undefined;
      const { chatId, messageId } = ref;
      return connection.use((s) => {
        const row = one(
          s,
          `SELECT ${TRANSCRIPT_COLUMNS}, ${SCOPE_COLUMNS.map(([, column]) => `t.${column}`).join(', ')} ` +
            'FROM deuz_chat_transcript t WHERE t.chat_id = ? AND t.message_id = ?',
          [chatId, messageId],
        );
        return row && scopeMatches(scopeOfRow(row), scope) ? messageOfRow(row) : undefined;
      });
    },
  };

  return {
    conditional: true,
    transcript,

    readChat(chatId) {
      return connection.use((s) => readOfRow(chatRow(s, chatId), chatId));
    },

    async writeChat(record, { expectedRevision }) {
      assertExpectedRevision('writeChat', expectedRevision);
      return write((s, now): ConditionalChatWriteResult => {
        const row = chatRow(s, record.chatId);
        if (isDeleted(row) || revisionOfRow(row) !== expectedRevision)
          return { status: 'conflict', current: readOfRow(row, record.chatId) };
        putChat(s, record, expectedRevision + 1, now);
        return { status: 'committed', record: storedRecord(s, record.chatId) };
      });
    },

    async tombstoneChat(chatId, { expectedRevision }) {
      assertExpectedRevision('tombstoneChat', expectedRevision);
      return write((s, now): ConditionalChatWriteResult => {
        const row = chatRow(s, chatId);
        if (isDeleted(row) || revisionOfRow(row) !== expectedRevision)
          return { status: 'conflict', current: readOfRow(row, chatId) };
        return {
          status: 'deleted',
          tombstone: buryChat(s, chatId, row, expectedRevision + 1, now),
        };
      });
    },

    async saveChat(record) {
      await write((s, now) => {
        const row = chatRow(s, record.chatId);
        if (isDeleted(row)) throw deletedChatError(record.chatId, revisionOfRow(row));
        putChat(s, record, revisionOfRow(row) + 1, now);
      });
    },

    loadChat(chatId) {
      return connection.use((s) => {
        const read = readOfRow(chatRow(s, chatId), chatId);
        return read.status === 'found' ? read.record : undefined;
      });
    },

    async deleteChat(chatId) {
      await write((s, now) => {
        const row = chatRow(s, chatId);
        if (!isDeleted(row)) buryChat(s, chatId, row, revisionOfRow(row) + 1, now);
      });
    },

    listChats(scope) {
      return connection.use((s) => {
        const scoped = scopeFilter(scope, '');
        return all(
          s,
          `SELECT chat_id FROM deuz_chat_conditional WHERE deleted_at IS NULL${scoped.sql} ` +
            'ORDER BY updated_at DESC, chat_id ASC',
          scoped.params,
        ).map((row) => String(row.chat_id));
      });
    },

    pruneTombstones(before) {
      return write((s) =>
        run(
          s,
          'DELETE FROM deuz_chat_conditional WHERE deleted_at IS NOT NULL AND deleted_at < ?',
          [before],
        ),
      );
    },

    close: () => connection.close(),
  };
}
