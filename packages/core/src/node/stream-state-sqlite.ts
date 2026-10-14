/**
 * The SQLite durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/stores/sqlite`: new tables with their own
 * `deuz_stream_state_schema` version table; a batch and its fencing check
 * are one transaction. Node-only.
 *
 * Two tables: one row per stream (its fence, last seq, whether the last record
 * is the `done` sentinel, and the store-clock time of its last open, commit or
 * append, which `prune` compares) and one row per record, the part as JSON
 * text. Every write is one `BEGIN IMMEDIATE` transaction with no `await`
 * inside, so processes sharing the file queue on the write lock and a stale
 * producer's batch is refused before any of it is stored. The rules are in
 * `internal/durable-stream.ts`.
 */
import type { DurableStreamStateStore } from '../types/stream-durable';
import type { Clock } from '../types/deps';
import { resolveDependencies } from '../internal/resolve-deps';
import {
  assertFencingToken,
  assertPart,
  assertSeq,
  assertStreamId,
  assertTerminalBefore,
  checkBatch,
  decodePart,
  encodePart,
  isDonePart,
  PRUNE_PAGE,
  READ_PAGE,
} from '../internal/durable-stream';
import {
  createSqliteConnection,
  createSqliteStatementCache,
  ensureSqliteSchema,
  sqliteTransaction,
  sqliteUnavailableMessage,
  type SqliteSchemaSpec,
} from './sqlite-handle';
import type { SqliteDatabaseLike } from './store-sqlite';
import type { SqliteConnectionOptions } from './store-connection';

/** Options of `createSqliteDurableStreamStateStore`. */
export type SqliteDurableStreamStateStoreOptions = SqliteConnectionOptions & {
  /** Stamps each open, commit and append: the time `prune` compares. Default: the host clock. */
  clock?: Clock;
};

/** The schema this build writes; its version lives in `deuz_stream_state_schema`. */
const SCHEMA: SqliteSchemaSpec = {
  name: 'deuz_stream_state',
  version: 1,
  create: [
    `CREATE TABLE IF NOT EXISTS deuz_stream_state_streams (
      stream_id TEXT PRIMARY KEY,
      token INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      done INTEGER NOT NULL,
      touched_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS deuz_stream_state_records (
      stream_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      part TEXT NOT NULL,
      PRIMARY KEY (stream_id, seq)
    )`,
    'CREATE INDEX IF NOT EXISTS deuz_stream_state_streams_terminal ON deuz_stream_state_streams (done, touched_at)',
  ],
};

interface HeadRow {
  token: number;
  last_seq: number;
}

/** The SQLite durable stream state store (2.4); `close()` closes only a connection it opened. */
export function createSqliteDurableStreamStateStore(
  options: SqliteDurableStreamStateStoreOptions,
): DurableStreamStateStore & { close(): Promise<void> } {
  const clock = options.clock ?? resolveDependencies().clock;
  const statement = createSqliteStatementCache();
  const connection = createSqliteConnection<SqliteDatabaseLike>(
    options.database
      ? // A borrowed handle keeps its journal mode: ':memory:' skips the WAL switch.
        { path: ':memory:', database: options.database }
      : { path: options.path, ...(options.wal !== undefined ? { wal: options.wal } : {}) },
    {
      injected: 'borrowed',
      closedMessage: 'SQLite durable stream state store is closed',
      unavailable: sqliteUnavailableMessage('createSqliteDurableStreamStateStore'),
      setup(db) {
        ensureSqliteSchema(db, SCHEMA);
        return db;
      },
    },
  );

  const head = (db: SqliteDatabaseLike, streamId: string): HeadRow | undefined =>
    statement(db, 'SELECT token, last_seq FROM deuz_stream_state_streams WHERE stream_id = ?').get(
      streamId,
    ) as HeadRow | undefined;

  const writeHead = (
    db: SqliteDatabaseLike,
    streamId: string,
    token: number,
    lastSeq: number,
    done: boolean,
  ): void => {
    statement(
      db,
      `INSERT INTO deuz_stream_state_streams (stream_id, token, last_seq, done, touched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (stream_id) DO UPDATE SET
         token = excluded.token, last_seq = excluded.last_seq,
         done = excluded.done, touched_at = excluded.touched_at`,
    ).run(streamId, token, lastSeq, done ? 1 : 0, clock.now());
  };

  return {
    durable: true,

    async open(streamId, token) {
      assertStreamId(streamId);
      assertFencingToken(token);
      return connection.use((db) =>
        sqliteTransaction(db, () => {
          const row = head(db, streamId);
          if (row && row.token > token) return { status: 'fenced' as const, token: row.token };
          if (row)
            statement(
              db,
              'UPDATE deuz_stream_state_streams SET token = ?, touched_at = ? WHERE stream_id = ?',
            ).run(token, clock.now(), streamId);
          else writeHead(db, streamId, token, -1, false);
          return { status: 'opened' as const, lastSeq: row?.last_seq ?? -1 };
        }),
      );
    },

    async commit(batch) {
      const checked = checkBatch(batch);
      return connection.use((db) =>
        sqliteTransaction(db, () => {
          const row = head(db, checked.streamId);
          if (row && row.token > checked.token)
            return { status: 'fenced' as const, token: row.token };
          const last = row?.last_seq ?? -1;
          if (checked.first !== undefined && checked.first !== last + 1)
            return { status: 'conflict' as const, lastSeq: last };
          const insert = statement(
            db,
            'INSERT INTO deuz_stream_state_records (stream_id, seq, part) VALUES (?, ?, ?)',
          );
          checked.encoded.forEach((part, index) =>
            insert.run(checked.streamId, last + 1 + index, part),
          );
          const lastSeq = last + checked.encoded.length;
          if (checked.encoded.length > 0 || !row)
            writeHead(db, checked.streamId, checked.token, lastSeq, checked.done);
          else
            statement(
              db,
              'UPDATE deuz_stream_state_streams SET token = ?, touched_at = ? WHERE stream_id = ?',
            ).run(checked.token, clock.now(), checked.streamId);
          return { status: 'committed' as const, lastSeq };
        }),
      );
    },

    async append(streamId, seq, part) {
      assertStreamId(streamId);
      assertSeq(seq);
      assertPart(part);
      const text = encodePart(part);
      await connection.use((db) =>
        sqliteTransaction(db, () => {
          statement(
            db,
            `INSERT INTO deuz_stream_state_records (stream_id, seq, part) VALUES (?, ?, ?)
             ON CONFLICT (stream_id, seq) DO UPDATE SET part = excluded.part`,
          ).run(streamId, seq, text);
          const row = statement(
            db,
            'SELECT token, last_seq, done FROM deuz_stream_state_streams WHERE stream_id = ?',
          ).get(streamId) as (HeadRow & { done: number }) | undefined;
          const last = row?.last_seq ?? -1;
          // The record with the highest seq decides whether the stream ended.
          const done = seq >= last ? isDonePart(part) : row?.done === 1;
          writeHead(db, streamId, row?.token ?? 0, Math.max(last, seq), done);
        }),
      );
    },

    async *read(streamId, fromSeq = -1) {
      let cursor = fromSeq;
      for (;;) {
        const rows = (await connection.use((db) =>
          statement(
            db,
            `SELECT seq, part FROM deuz_stream_state_records
             WHERE stream_id = ? AND seq > ? ORDER BY seq LIMIT ${READ_PAGE}`,
          ).all(streamId, cursor),
        )) as { seq: number; part: string }[];
        for (const row of rows) {
          cursor = Number(row.seq);
          yield { seq: cursor, part: decodePart(row.part) };
        }
        if (rows.length < READ_PAGE) return;
      }
    },

    async lastSeq(streamId) {
      const row = await connection.use((db) => head(db, streamId));
      return row && row.last_seq >= 0 ? Number(row.last_seq) : undefined;
    },

    async delete(streamId) {
      await connection.use((db) =>
        sqliteTransaction(db, () => {
          statement(db, 'DELETE FROM deuz_stream_state_records WHERE stream_id = ?').run(streamId);
          statement(db, 'DELETE FROM deuz_stream_state_streams WHERE stream_id = ?').run(streamId);
        }),
      );
    },

    async prune(pruneOptions) {
      const terminalBefore = assertTerminalBefore(pruneOptions);
      let removed = 0;
      for (;;) {
        // One transaction per page, so a large backlog never holds the write lock long.
        const count = await connection.use((db) =>
          sqliteTransaction(db, () => {
            const ids = (
              statement(
                db,
                `SELECT stream_id FROM deuz_stream_state_streams
                 WHERE done = 1 AND touched_at < ? LIMIT ${PRUNE_PAGE}`,
              ).all(terminalBefore) as { stream_id: string }[]
            ).map((row) => row.stream_id);
            for (const id of ids) {
              statement(db, 'DELETE FROM deuz_stream_state_records WHERE stream_id = ?').run(id);
              statement(db, 'DELETE FROM deuz_stream_state_streams WHERE stream_id = ?').run(id);
            }
            return ids.length;
          }),
        );
        removed += count;
        if (count < PRUNE_PAGE) return removed;
      }
    },

    close: () => connection.close(),
  };
}
