/**
 * A pool over one PGlite database (2.4), for offline tests of the stores that
 * pin a connection with `withPgTransaction`. PGlite has a single connection,
 * so the pool lends it to one holder at a time: `connect()` waits until the
 * previous holder releases it, and the pool's own `query()` waits too, so a
 * statement never lands inside someone else's transaction. On a live server
 * use `pg.Pool`, where transactions really run side by side.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgClientLike } from '../../src/node/store-postgres';
import type { PgPoolClientLike, PgPoolLike } from '../../src/node/pg-tx';

export interface PglitePool extends PgPoolLike {
  /** Connections lent and given back so far: equal when nothing leaked. */
  stats(): { connected: number; released: number };
}

export function pglitePool(db: PGlite): PglitePool {
  let tail: Promise<void> = Promise.resolve();
  let connected = 0;
  let released = 0;
  /** Waits for the connection, and resolves to the function that gives it back. */
  const acquire = (): Promise<() => void> => {
    let free!: () => void;
    const held = new Promise<void>((resolve) => (free = resolve));
    const turn = tail.then(() => free);
    tail = tail.then(() => held);
    return turn;
  };
  // PGlite's query() takes one statement; a parameterless batch goes through exec().
  const run: PgClientLike['query'] = async (sql, params) => {
    if (params === undefined && sql.includes(';')) {
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
    }
    return db.query<Record<string, unknown>>(sql, params);
  };
  return {
    async query(sql, params) {
      const free = await acquire();
      try {
        return await run(sql, params);
      } finally {
        free();
      }
    },
    async connect(): Promise<PgPoolClientLike> {
      const free = await acquire();
      connected++;
      let done = false;
      return {
        query: run,
        release() {
          if (done) return;
          done = true;
          released++;
          free();
        },
      };
    },
    stats: () => ({ connected, released }),
  };
}
