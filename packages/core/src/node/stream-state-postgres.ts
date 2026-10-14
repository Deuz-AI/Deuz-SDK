/**
 * The PostgreSQL durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/stores/postgres`: new tables with their own
 * `deuz_stream_state_schema` version table; a batch and its fencing check
 * share one pinned transaction. Node-only.
 *
 * Two tables, as on SQLite: one row per stream (its fence, last seq, whether
 * the last record is the `done` sentinel, and the database time of its last
 * open, commit or append, which `prune` compares) and one row per record,
 * the part as `TEXT` (a `jsonb` column would reorder the keys, and a replay
 * must send the bytes the live response sent). A commit locks the stream's
 * row (`SELECT … FOR UPDATE`) inside `withPgTransaction`, so racing producers
 * queue on it, and a serialization failure or deadlock runs the transaction
 * again; nothing outside the transaction happens in it. A refused batch rolls
 * back whole. Time is the database's `clock_timestamp()`, never a host clock.
 * The rules are in `internal/durable-stream.ts`.
 */
import type { DurableStreamCommitResult, DurableStreamStateStore } from '../types/stream-durable';
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
import type { PgClientLike } from './store-postgres';
import { assertPgPool, ensurePgSchema, withPgTransaction, type PgPoolLike } from './pg-tx';
import type { PostgresConnectionOptions } from './store-connection';

/** Options of `createPostgresDurableStreamStateStore`. */
export type PostgresDurableStreamStateStoreOptions = PostgresConnectionOptions;

const FACTORY = 'createPostgresDurableStreamStateStore';
const NOW = '(extract(epoch from clock_timestamp()) * 1000)::bigint';
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
/** Rows one INSERT carries: two parameters each, far under Postgres's 65 535. */
const INSERT_ROWS = 500;

interface PgModule {
  Pool?: new (config: { connectionString: string }) => PgPoolLike;
  default?: { Pool?: new (config: { connectionString: string }) => PgPoolLike };
}

/** The optional `pg` peer, imported on first use (`as string` keeps the dts build off it). */
async function openPool(connectionString: string): Promise<PgPoolLike> {
  let mod: PgModule;
  try {
    mod = (await import('pg' as string)) as unknown as PgModule;
  } catch (cause) {
    throw new Error(
      `${FACTORY}({ connectionString }) needs the optional peer 'pg' (npm i pg), or pass { pool }.`,
      { cause },
    );
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) throw new Error(`The installed 'pg' module exposes no Pool; pass { pool } instead.`);
  return new Pool({ connectionString });
}

/** A refusal decided inside a transaction: thrown to roll it back, then returned. */
class Refusal {
  constructor(readonly result: DurableStreamCommitResult) {}
}

/** The PostgreSQL durable stream state store (2.4). */
export function createPostgresDurableStreamStateStore(
  options: PostgresDurableStreamStateStoreOptions,
): DurableStreamStateStore & { migrate(): Promise<void>; close(): Promise<void> } {
  const borrowed = 'pool' in options ? options.pool : undefined;
  const connectionString = 'connectionString' in options ? options.connectionString : undefined;
  if (borrowed) assertPgPool(borrowed, FACTORY);
  else if (typeof connectionString !== 'string' || !connectionString)
    throw new TypeError(`${FACTORY} needs { pool } (such as pg.Pool) or { connectionString }.`);
  const schema = options.schema ?? 'public';
  if (!SCHEMA_NAME.test(schema) || schema.length > 63)
    throw new TypeError(
      `Invalid Postgres schema name ${JSON.stringify(schema)}: use lower-case letters, digits and underscores.`,
    );
  const streams = `${schema}.deuz_stream_state_streams`;
  const recordsTable = `${schema}.deuz_stream_state_records`;

  let owned: Promise<PgPoolLike> | undefined;
  let migrated: Promise<void> | undefined;
  let closed = false;

  const pool = (): Promise<PgPoolLike> => {
    if (closed) return Promise.reject(new Error('Postgres durable stream state store is closed'));
    if (borrowed) return Promise.resolve(borrowed);
    if (!owned) {
      const opening = openPool(connectionString!);
      owned = opening;
      // A failed open must not poison the store: the next call opens again.
      opening.catch(() => {
        if (owned === opening) owned = undefined;
      });
    }
    return owned;
  };

  const migrate = (): Promise<void> => {
    migrated ??= (async () => {
      await ensurePgSchema(await pool(), {
        name: 'deuz_stream_state',
        version: 1,
        schema,
        create: [
          `CREATE TABLE IF NOT EXISTS ${streams} (
            stream_id TEXT PRIMARY KEY,
            token BIGINT NOT NULL,
            last_seq BIGINT NOT NULL,
            done BOOLEAN NOT NULL,
            touched_at BIGINT NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS ${recordsTable} (
            stream_id TEXT NOT NULL,
            seq BIGINT NOT NULL,
            part TEXT NOT NULL,
            PRIMARY KEY (stream_id, seq)
          )`,
          `CREATE INDEX IF NOT EXISTS deuz_stream_state_streams_terminal ON ${streams} (done, touched_at)`,
        ],
      });
    })().catch((error: unknown) => {
      migrated = undefined;
      throw error;
    });
    return migrated;
  };

  /** The schema is ready and the pool to use. */
  const ready = async (): Promise<PgPoolLike> => {
    await migrate();
    return pool();
  };

  /** Creates the stream's row if missing, then locks it: racing writers queue here. */
  const lockHead = async (tx: PgClientLike, streamId: string) => {
    await tx.query(
      `INSERT INTO ${streams} (stream_id, token, last_seq, done, touched_at)
       VALUES ($1, 0, -1, false, ${NOW}) ON CONFLICT (stream_id) DO NOTHING`,
      [streamId],
    );
    const { rows } = await tx.query(
      `SELECT token, last_seq, done FROM ${streams} WHERE stream_id = $1 FOR UPDATE`,
      [streamId],
    );
    const row = rows[0]!;
    return { token: Number(row.token), last: Number(row.last_seq), done: row.done === true };
  };

  return {
    durable: true,

    async open(streamId, token) {
      assertStreamId(streamId);
      assertFencingToken(token);
      return withPgTransaction(await ready(), async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO ${streams} AS s (stream_id, token, last_seq, done, touched_at)
           VALUES ($1, $2, -1, false, ${NOW})
           ON CONFLICT (stream_id) DO UPDATE SET token = EXCLUDED.token, touched_at = EXCLUDED.touched_at
           WHERE s.token <= EXCLUDED.token
           RETURNING last_seq`,
          [streamId, token],
        );
        if (rows[0]) return { status: 'opened' as const, lastSeq: Number(rows[0].last_seq) };
        const fence = await tx.query(`SELECT token FROM ${streams} WHERE stream_id = $1`, [
          streamId,
        ]);
        return { status: 'fenced' as const, token: Number(fence.rows[0]!.token) };
      });
    },

    async commit(batch) {
      const checked = checkBatch(batch);
      const target = await ready();
      try {
        return await withPgTransaction(target, async (tx) => {
          const head = await lockHead(tx, checked.streamId);
          if (head.token > checked.token)
            throw new Refusal({ status: 'fenced', token: head.token });
          if (checked.first !== undefined && checked.first !== head.last + 1)
            throw new Refusal({ status: 'conflict', lastSeq: head.last });
          for (let offset = 0; offset < checked.encoded.length; offset += INSERT_ROWS) {
            const chunk = checked.encoded.slice(offset, offset + INSERT_ROWS);
            const params: unknown[] = [checked.streamId];
            const rows = chunk.map((part, index) => {
              params.push(head.last + 1 + offset + index, part);
              return `($1, $${params.length - 1}, $${params.length})`;
            });
            await tx.query(
              `INSERT INTO ${recordsTable} (stream_id, seq, part) VALUES ${rows.join(', ')}`,
              params,
            );
          }
          const lastSeq = head.last + checked.encoded.length;
          const done = checked.encoded.length > 0 ? checked.done : head.done;
          await tx.query(
            `UPDATE ${streams} SET token = $2, last_seq = $3, done = $4, touched_at = ${NOW}
             WHERE stream_id = $1`,
            [checked.streamId, checked.token, lastSeq, done],
          );
          return { status: 'committed' as const, lastSeq };
        });
      } catch (error) {
        if (error instanceof Refusal) return error.result;
        throw error;
      }
    },

    async append(streamId, seq, part) {
      assertStreamId(streamId);
      assertSeq(seq);
      assertPart(part);
      const text = encodePart(part);
      await withPgTransaction(await ready(), async (tx) => {
        const head = await lockHead(tx, streamId);
        await tx.query(
          `INSERT INTO ${recordsTable} (stream_id, seq, part) VALUES ($1, $2, $3)
           ON CONFLICT (stream_id, seq) DO UPDATE SET part = EXCLUDED.part`,
          [streamId, seq, text],
        );
        // The record with the highest seq decides whether the stream ended.
        const done = seq >= head.last ? isDonePart(part) : head.done;
        await tx.query(
          `UPDATE ${streams} SET last_seq = $2, done = $3, touched_at = ${NOW} WHERE stream_id = $1`,
          [streamId, Math.max(head.last, seq), done],
        );
      });
    },

    async *read(streamId, fromSeq = -1) {
      let cursor = fromSeq;
      for (;;) {
        const { rows } = await (
          await ready()
        ).query(
          `SELECT seq, part FROM ${recordsTable}
           WHERE stream_id = $1 AND seq > $2 ORDER BY seq LIMIT ${READ_PAGE}`,
          [streamId, cursor],
        );
        for (const row of rows) {
          cursor = Number(row.seq);
          yield { seq: cursor, part: decodePart(String(row.part)) };
        }
        if (rows.length < READ_PAGE) return;
      }
    },

    async lastSeq(streamId) {
      const { rows } = await (
        await ready()
      ).query(`SELECT last_seq FROM ${streams} WHERE stream_id = $1`, [streamId]);
      const last = rows[0] === undefined ? -1 : Number(rows[0].last_seq);
      return last >= 0 ? last : undefined;
    },

    async delete(streamId) {
      await withPgTransaction(await ready(), async (tx) => {
        await tx.query(`DELETE FROM ${recordsTable} WHERE stream_id = $1`, [streamId]);
        await tx.query(`DELETE FROM ${streams} WHERE stream_id = $1`, [streamId]);
      });
    },

    async prune(pruneOptions) {
      const terminalBefore = assertTerminalBefore(pruneOptions);
      const target = await ready();
      let removed = 0;
      for (;;) {
        // One statement per page; a stream a producer holds locked right now is skipped.
        const count = await withPgTransaction(target, async (tx) => {
          const { rows } = await tx.query(
            `WITH doomed AS (
               SELECT stream_id FROM ${streams} WHERE done AND touched_at < $1
               ORDER BY touched_at LIMIT ${PRUNE_PAGE} FOR UPDATE SKIP LOCKED
             ), gone AS (
               DELETE FROM ${recordsTable} r USING doomed d WHERE r.stream_id = d.stream_id
             )
             DELETE FROM ${streams} s USING doomed d WHERE s.stream_id = d.stream_id
             RETURNING s.stream_id`,
            [Math.floor(terminalBefore)],
          );
          return rows.length;
        });
        removed += count;
        if (count < PRUNE_PAGE) return removed;
      }
    },

    migrate,

    async close() {
      if (closed) return;
      closed = true;
      const opening = owned;
      owned = undefined;
      const opened = await opening?.catch(() => undefined);
      await opened?.end?.();
    },
  };
}
