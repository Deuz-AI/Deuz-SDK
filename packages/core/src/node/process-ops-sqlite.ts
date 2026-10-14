/**
 * The SQLite `ProcessOperationStore` (2.4), published from
 * `@deuz-sdk/core/compute/docker`: new tables with their own
 * `deuz_process_ops_schema` version table. Node-only.
 *
 * One row per (scope, operation id): the record as JSON, plus the columns the
 * compare-and-set, the list order and retention read. Every write is one
 * `BEGIN IMMEDIATE` transaction with no `await` inside it, so two processes
 * sharing the file serialize on the write lock and a stale revision loses.
 */
import type { ProcessOperationRecord, ProcessOperationStore } from '../compute/docker/types';
import {
  applyChanges,
  assertNewRecord,
  encodeCursor,
  initialRecord,
  operationConflict,
  resolveQuery,
  TERMINAL_PROCESS_STATES,
} from '../compute/docker/store-shared';
import type { Clock } from '../types/deps';
import { resolveDependencies } from '../internal/resolve-deps';
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

/** Options of `createSqliteProcessOperationStore`. */
export type SqliteProcessOperationStoreOptions = SqliteConnectionOptions & { clock?: Clock };

/** The schema this build writes; its version lives in `deuz_process_ops_schema`. */
const SCHEMA: SqliteSchemaSpec = {
  name: 'deuz_process_ops',
  version: 1,
  create: [
    `CREATE TABLE IF NOT EXISTS deuz_process_ops (
      scope TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      record TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, operation_id)
    )`,
    'CREATE INDEX IF NOT EXISTS deuz_process_ops_order ON deuz_process_ops (created_at, scope, operation_id)',
    'CREATE INDEX IF NOT EXISTS deuz_process_ops_terminal ON deuz_process_ops (state, updated_at)',
  ],
};

interface Row {
  record: string;
}

const TERMINAL = [...TERMINAL_PROCESS_STATES];

/** The SQLite process operation store (2.4); `close()` closes only a connection it opened. */
export function createSqliteProcessOperationStore(
  options: SqliteProcessOperationStoreOptions,
): ProcessOperationStore & { close(): Promise<void> } {
  const clock = options.clock ?? resolveDependencies().clock;
  const statement = createSqliteStatementCache();
  const connection = createSqliteConnection<SqliteDatabaseLike>(
    options.database
      ? // A borrowed handle keeps its journal mode: ':memory:' skips the WAL switch.
        { path: ':memory:', database: options.database }
      : { path: options.path, ...(options.wal !== undefined ? { wal: options.wal } : {}) },
    {
      injected: 'borrowed',
      closedMessage: 'SQLite process operation store is closed',
      unavailable: sqliteUnavailableMessage('createSqliteProcessOperationStore'),
      setup(db) {
        ensureSqliteSchema(db, SCHEMA);
        return db;
      },
    },
  );

  const read = (db: SqliteDatabaseLike, scope: string, operationId: string) => {
    const row = statement(
      db,
      'SELECT record FROM deuz_process_ops WHERE scope = ? AND operation_id = ?',
    ).get(scope, operationId) as Row | undefined;
    return row ? (JSON.parse(row.record) as ProcessOperationRecord) : undefined;
  };

  return {
    create(record) {
      assertNewRecord(record);
      return connection.use((db) =>
        sqliteTransaction(db, () => {
          const stored = read(db, record.scope, record.operationId);
          if (stored) {
            if (stored.requestDigest !== record.requestDigest)
              throw operationConflict(stored, record.requestDigest);
            return { status: 'existing' as const, record: stored };
          }
          const created = initialRecord(record, clock.now());
          statement(
            db,
            `INSERT INTO deuz_process_ops
               (scope, operation_id, revision, state, request_digest, record, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            created.scope,
            created.operationId,
            created.revision,
            created.state,
            created.requestDigest,
            JSON.stringify(created),
            created.createdAt,
            created.updatedAt,
          );
          return { status: 'created' as const, record: created };
        }),
      );
    },

    get(scope, operationId) {
      return connection.use((db) => read(db, scope, operationId));
    },

    update(scope, operationId, changes, { expectedRevision }) {
      return connection.use((db) =>
        sqliteTransaction(db, () => {
          const stored = read(db, scope, operationId);
          if (!stored) return { status: 'conflict' as const };
          if (stored.revision !== expectedRevision)
            return { status: 'conflict' as const, record: stored };
          const next = applyChanges(stored, changes, clock.now());
          statement(
            db,
            `UPDATE deuz_process_ops SET revision = ?, state = ?, record = ?, updated_at = ?
             WHERE scope = ? AND operation_id = ? AND revision = ?`,
          ).run(
            next.revision,
            next.state,
            JSON.stringify(next),
            next.updatedAt,
            scope,
            operationId,
            expectedRevision,
          );
          return { status: 'committed' as const, record: next };
        }),
      );
    },

    async list(query) {
      const resolved = resolveQuery(query);
      return connection.use((db) => {
        const where: string[] = [];
        const params: unknown[] = [];
        if (resolved.scope !== undefined) {
          where.push('scope = ?');
          params.push(resolved.scope);
        }
        if (resolved.states !== undefined) {
          if (resolved.states.length === 0) return { records: [] };
          where.push(`state IN (${resolved.states.map(() => '?').join(', ')})`);
          params.push(...resolved.states);
        }
        if (resolved.after) {
          const { createdAt, scope, operationId } = resolved.after;
          where.push(
            '(created_at > ? OR (created_at = ? AND (scope > ? OR (scope = ? AND operation_id > ?))))',
          );
          params.push(createdAt, createdAt, scope, scope, operationId);
        }
        const rows = statement(
          db,
          `SELECT record FROM deuz_process_ops
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY created_at, scope, operation_id LIMIT ?`,
        ).all(...params, resolved.limit + 1) as Row[];
        const records = rows
          .slice(0, resolved.limit)
          .map((row) => JSON.parse(row.record) as ProcessOperationRecord);
        const last = records[records.length - 1];
        return rows.length > resolved.limit && last
          ? { records, cursor: encodeCursor(last) }
          : { records };
      });
    },

    prune({ terminalBefore }) {
      return connection.use((db) => {
        const result = statement(
          db,
          `DELETE FROM deuz_process_ops
           WHERE state IN (${TERMINAL.map(() => '?').join(', ')}) AND updated_at < ?`,
        ).run(...TERMINAL, terminalBefore) as { changes?: number | bigint };
        return Number(result.changes ?? 0);
      });
    },

    async close() {
      await connection.close();
      statement.clear();
    },
  };
}
