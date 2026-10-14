/**
 * The SQLite plumbing every store shares (2.4): open-or-borrow, a busy timeout
 * and WAL, the transaction helper, close ownership, and the schema-meta helper
 * a new store keeps its version in. The 2.3 stores (`store-sqlite.ts`,
 * `ops-sqlite.ts`) run on the same pieces, with their own policies.
 *
 * Ownership (spec §4.2): a store closes a handle it opened itself. A handle
 * passed in as `options.database` is BORROWED by the stores 2.4 adds, which
 * leave it open, and OWNED by the 2.3 stores, whose documented contract is
 * that close() closes it.
 *
 * Every helper is synchronous between BEGIN and COMMIT. A store has one
 * connection, so a transaction must never span an `await`: another call would
 * run its statements inside it. Node-only.
 */
import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import { ensureBusyTimeout } from './sqlite-open';
import {
  assertStoredSchemaVersion,
  planSchemaMeta,
  type SchemaMetaSpec,
  type SchemaMetaState,
} from './schema-meta';

export type { SchemaMetaState } from './schema-meta';

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabaseLike;
}

/**
 * The actionable error for a runtime without `node:sqlite`: which Node versions
 * ship it, the flag that unlocks it on the ones that don't, and the escape
 * hatch that needs neither. `factory` names the caller, e.g. `createSqliteStores`.
 */
export function sqliteUnavailableMessage(factory: string): string {
  return (
    `${factory}: node:sqlite is unavailable. It ships unflagged from Node 22.13 / 23.4; ` +
    'on Node 22.5–22.12 run node with --experimental-sqlite, or pass options.database ' +
    '(a better-sqlite3-compatible handle).'
  );
}

/**
 * Opens `path` with `node:sqlite`, imported on first use. With `unavailable`, a
 * runtime that lacks the module fails with that message, the import error as
 * its cause; without it, the import error itself is thrown.
 */
export async function openSqliteDatabase(
  path: string,
  unavailable?: string,
): Promise<SqliteDatabaseLike> {
  if (unavailable === undefined) {
    const module = (await import('node:sqlite' as string)) as NodeSqliteModule;
    return new module.DatabaseSync(path);
  }
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
    throw new Error(unavailable, { cause: err });
  }
  if (!Database) throw new Error(unavailable);
  // Deliberately outside the try — an unwritable path is a different problem
  // and deserves SQLite's own message, not the version matrix.
  return new Database(path);
}

export interface SqliteConnectionSettings {
  /** Database file, or `':memory:'`. */
  path: string;
  /** `PRAGMA journal_mode = WAL` for file databases. Default on; ignored for `':memory:'`. */
  wal?: boolean;
  /**
   * A WAL switch that fails: `'throw'` (default) fails the open, `'ignore'`
   * keeps the current journal (a read-only mount, an injected in-memory handle).
   */
  walFailure?: 'throw' | 'ignore';
}

/**
 * Gives a connection its busy timeout, then switches a file database to WAL.
 * The timeout comes first: switching to WAL takes a write lock that another
 * process may hold.
 */
export function configureSqliteConnection(
  db: SqliteDatabaseLike,
  settings: SqliteConnectionSettings,
): void {
  ensureBusyTimeout(db);
  if (settings.path === ':memory:' || settings.wal === false) return;
  if (settings.walFailure !== 'ignore') {
    db.exec('PRAGMA journal_mode = WAL');
    return;
  }
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    /* a read-only mount / an injected in-memory handle keeps its journal */
  }
}

/**
 * `'immediate'` takes the write lock at BEGIN, so a read-then-write cannot lose
 * a race to another connection and fail with SQLITE_BUSY half way; every store
 * that several processes share uses it. `'deferred'` takes it at the first write.
 */
export type SqliteTransactionMode = 'immediate' | 'deferred';

/**
 * Runs `fn` in one transaction: COMMIT when it returns, ROLLBACK when it
 * throws, and the error rethrown. A ROLLBACK that fails too (SQLite may have
 * unwound the transaction already) never hides the error that caused it.
 */
export function sqliteTransaction<T>(
  db: SqliteDatabaseLike,
  fn: () => T,
  mode: SqliteTransactionMode = 'immediate',
): T {
  db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the failure that got us here may already have unwound it */
    }
    throw error;
  }
}

/** Prepared statements by SQL text, for one connection at a time. */
export interface SqliteStatementCache {
  (db: SqliteDatabaseLike, sql: string): SqliteStatementLike;
  /** Forget every statement, when the connection closes. */
  clear(): void;
}

/** A cache of prepared statements: each SQL text is prepared once. */
export function createSqliteStatementCache(): SqliteStatementCache {
  const statements = new Map<string, SqliteStatementLike>();
  const cache = ((db: SqliteDatabaseLike, sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }) as SqliteStatementCache;
  cache.clear = () => statements.clear();
  return cache;
}

/** Where a store's handle comes from. */
export interface SqliteOpenOptions {
  /** Database file, or `':memory:'`. */
  path: string;
  /** Use this handle instead of opening `node:sqlite`. */
  database?: SqliteDatabaseLike;
  /** `PRAGMA journal_mode = WAL` for file databases. Default on; ignored for `':memory:'`. */
  wal?: boolean;
}

export interface SqliteOpenPolicy<T> {
  /**
   * Builds the store's state on the configured handle (schema, prepared
   * pieces) and returns it. A throw fails this open; the next call retries.
   */
  setup(db: SqliteDatabaseLike): T;
  /** The message for a runtime without `node:sqlite`: see `openSqliteDatabase`. */
  unavailable?: string;
  /** See `SqliteConnectionSettings.walFailure`. Default `'throw'`. */
  walFailure?: 'throw' | 'ignore';
}

/** Memoized open: every call shares one attempt until it fails. */
export interface SqliteOpener<T> {
  (): Promise<T>;
  /** The current attempt, pending or settled; `undefined` before the first and after a failed one. */
  readonly pending: Promise<T> | undefined;
}

/**
 * Opens the store's handle on first use, or borrows `options.database`, then
 * configures it and runs `setup`. Every caller shares one attempt. A failed
 * attempt is forgotten, so it never poisons the store: the next call opens
 * again. When configuring or setup fails, a handle this attempt opened is
 * closed; an injected one stays open for the retry.
 */
export function createSqliteOpener<T>(
  options: SqliteOpenOptions,
  policy: SqliteOpenPolicy<T>,
): SqliteOpener<T> {
  let opening: Promise<T> | undefined;
  const attempt = async (): Promise<T> => {
    const db = options.database ?? (await openSqliteDatabase(options.path, policy.unavailable));
    try {
      configureSqliteConnection(db, {
        path: options.path,
        wal: options.wal,
        walFailure: policy.walFailure,
      });
      return policy.setup(db);
    } catch (error) {
      // An injected handle stays open: the next call retries on it.
      if (!options.database) db.close();
      throw error;
    }
  };
  const open = (() => {
    if (!opening) {
      opening = attempt();
      // A failed open must not poison the store for the rest of the process.
      opening.catch(() => {
        opening = undefined;
      });
    }
    return opening;
  }) as SqliteOpener<T>;
  Object.defineProperty(open, 'pending', { get: () => opening });
  return open;
}

export interface SqliteConnectionPolicy<T> extends SqliteOpenPolicy<T> {
  /**
   * Who closes `options.database`: `'borrowed'` leaves it open (the stores
   * 2.4 adds), `'owned'` closes it on close(), even unused (the 2.3 stores).
   * A handle the connection opened itself is always closed.
   */
  injected: 'borrowed' | 'owned';
  /** The error a call after close() rejects with. Default `'SQLite store is closed'`. */
  closedMessage?: string;
}

/** A store's one connection: calls are admitted until close(), which waits for them. */
export interface SqliteConnection<T> {
  /**
   * Runs `operation` on the opened state, opening it first if need be.
   * Rejected after close(). An async operation counts until it settles, but
   * no transaction may stay open across its awaits.
   */
  use<R>(operation: (opened: T) => R): Promise<Awaited<R>>;
  /** Refuses new calls, waits for admitted ones, then closes what the store owns. Idempotent. */
  close(): Promise<void>;
}

/**
 * A store's connection lifecycle: `createSqliteOpener` plus admission, drain
 * and close ownership. close() refuses new calls at once, waits for every
 * admitted one, then closes the handle the store opened, and an injected one
 * only when `injected` is `'owned'`.
 */
export function createSqliteConnection<T>(
  options: SqliteOpenOptions,
  policy: SqliteConnectionPolicy<T>,
): SqliteConnection<T> {
  const open = createSqliteOpener(options, {
    unavailable: policy.unavailable,
    walFailure: policy.walFailure,
    setup: (db) => ({ db, opened: policy.setup(db) }),
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  let admitted = 0;
  let drained: (() => void) | undefined;
  return {
    async use<R>(operation: (opened: T) => R): Promise<Awaited<R>> {
      if (closed) throw new Error(policy.closedMessage ?? 'SQLite store is closed');
      admitted++;
      try {
        return await operation((await open()).opened);
      } finally {
        admitted--;
        if (admitted === 0) drained?.();
      }
    },
    close() {
      closing ??= (async () => {
        closed = true;
        if (admitted)
          await new Promise<void>((resolve) => {
            drained = resolve;
          });
        // A failed open already closed a handle the store made itself.
        const state = await open.pending?.catch(() => undefined);
        if (policy.injected === 'owned') (state?.db ?? options.database)?.close();
        else if (state && !options.database) state.db.close();
      })();
      return closing;
    },
  };
}

/** One upgrade step: SQL text run with `exec`, or code given the handle. */
export type SqliteSchemaStep = string | ((db: SqliteDatabaseLike) => void);

/** A new store's schema: see `SchemaMetaSpec`. */
export type SqliteSchemaSpec = SchemaMetaSpec<SqliteSchemaStep>;

/**
 * Creates or upgrades a new store's schema in one `BEGIN IMMEDIATE`
 * transaction, so processes opening one file at once queue instead of racing:
 *
 * - the version lives in `<name>_schema` (one row, `singleton = 1`), never in
 *   `PRAGMA user_version` or another store's table;
 * - a newer stored version is refused with an error naming both, an older one
 *   runs every upgrade step from it in order, then the `create` statements,
 *   then the version is written;
 * - any failure rolls the whole open back, so the schema stays as it was.
 */
export function ensureSqliteSchema(
  db: SqliteDatabaseLike,
  spec: SqliteSchemaSpec,
): SchemaMetaState {
  const plan = planSchemaMeta(spec);
  const { table } = plan;
  return sqliteTransaction(db, () => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)`,
    );
    const row = db.prepare(`SELECT version FROM ${table} WHERE singleton = 1`).get() as
      | { version: unknown }
      | undefined;
    const stored = row === undefined ? undefined : Number(row.version);
    assertStoredSchemaVersion(plan, spec.version, stored, table);
    if (stored !== undefined)
      for (const step of plan.steps) {
        if (stored > step.from) continue;
        for (const run of step.run) {
          if (typeof run === 'string') db.exec(run);
          else run(db);
        }
      }
    for (const sql of spec.create) db.exec(sql);
    // The version is a validated integer, so there is nothing to bind.
    if (stored === undefined)
      db.exec(`INSERT INTO ${table} (singleton, version) VALUES (1, ${spec.version})`);
    else if (stored < spec.version)
      db.exec(`UPDATE ${table} SET version = ${spec.version} WHERE singleton = 1`);
    return { stored, version: spec.version };
  });
}
