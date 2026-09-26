/**
 * The Postgres `BudgetStore` (2.2).
 *
 * `PgClientLike` exposes one `query()` call, and a pooled client may run two
 * calls on two connections, so every state change here is ONE statement:
 *
 * - Admission locks the scope rows (`FOR UPDATE`, in key order) and decides
 *   from the rolling-window ring stored ON those rows. Under READ COMMITTED a
 *   statement keeps its start snapshot for every other table, but a row locked
 *   with `FOR UPDATE` is returned in its newest version, so the decision never
 *   reads counts older than the lock. The request row, the ring and the
 *   per-model history are written by the same statement.
 * - Settlement and release move a request out of `reserved` with a row lock,
 *   so concurrent callers apply each transition exactly once.
 *
 * Windows run on database time (`clock_timestamp()`), never on host clocks.
 * `BIGINT` and `numeric` values arrive as strings from `pg` and are coerced
 * with `Number()`. The schema is created by one locked statement
 * (`postgres-migrate.ts`), so concurrent first uses never race.
 */
import type { PgClientLike } from './store-postgres';
import { postgresSchemaStatement } from './postgres-migrate';
import type { BudgetStore, BudgetStoreReservation } from '../types/budget-store';
import {
  assertBudgetActual,
  assertBudgetKey,
  assertSameWindow,
  assertUsageOptions,
  BudgetStoreError,
  normalizeBudgetReserve,
  planBudgetTransition,
  reservationConflict,
  roundBudgetOutcome,
  summarizeBudgetUsage,
} from '../budget-store';

export interface PostgresBudgetStoreOptions {
  client: PgClientLike;
  /** Schema holding the `deuz_budget_*` tables. Default `'public'`; must already exist. */
  schema?: string;
}

const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const SCHEMA_VERSION = 1;
const NOW_MS = '(extract(epoch from clock_timestamp()) * 1000)::bigint';

type RequestState = 'reserved' | 'settled' | 'released' | 'denied';

export function createPostgresBudgetStore(options: PostgresBudgetStoreOptions): BudgetStore {
  const schema = options.schema ?? 'public';
  if (!SCHEMA_NAME_PATTERN.test(schema) || schema.length > 63)
    throw new BudgetStoreError(
      'invalid_request',
      `Invalid Postgres schema name ${JSON.stringify(schema)}: use lower-case letters, digits and underscores.`,
    );
  const client = options.client;
  const t = (name: string) => `${schema}.deuz_budget_${name}`;
  let migrating: Promise<void> | undefined;

  // One statement (a DO block) under an advisory lock: see postgres-migrate.ts.
  const schemaSql = postgresSchemaStatement({
    lock: `budget:${schema}`,
    meta: t('schema'),
    version: SCHEMA_VERSION,
    unsupported: 'Unsupported Postgres budget schema version',
    create: [
      `CREATE TABLE IF NOT EXISTS ${t('scopes')} (
        key TEXT PRIMARY KEY, window_ms BIGINT, buckets INTEGER NOT NULL, bucket_ms BIGINT NOT NULL,
        ring_idx BIGINT[] NOT NULL, ring_tokens BIGINT[] NOT NULL, ring_usd DOUBLE PRECISION[] NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${t('counters')} (
        key TEXT NOT NULL, bucket BIGINT NOT NULL, model_id TEXT NOT NULL,
        tokens BIGINT NOT NULL, usd DOUBLE PRECISION NOT NULL, PRIMARY KEY (key, bucket, model_id))`,
      `CREATE TABLE IF NOT EXISTS ${t('requests')} (
        request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, model_id TEXT NOT NULL,
        tokens BIGINT NOT NULL, usd DOUBLE PRECISION NOT NULL, state TEXT NOT NULL, charges JSONB NOT NULL,
        actual_tokens BIGINT, actual_usd DOUBLE PRECISION, outcome JSONB NOT NULL, created_at BIGINT NOT NULL)`,
    ],
  });

  const migrate = (): Promise<void> => {
    migrating ??= (async () => {
      await client.query(schemaSql);
    })().catch((error: unknown) => {
      migrating = undefined;
      throw error;
    });
    return migrating;
  };

  /** jsonb arrives parsed from `pg` and PGlite, as text from some drivers. */
  const parse = (value: unknown): BudgetStoreReservation | undefined =>
    value === null || value === undefined
      ? undefined
      : roundBudgetOutcome(
          (typeof value === 'string' ? JSON.parse(value) : value) as BudgetStoreReservation,
        );

  const readRequest = async (requestId: string) => {
    const { rows } = await client.query(
      `SELECT fingerprint, state, actual_tokens, actual_usd, outcome FROM ${t('requests')} WHERE request_id = $1`,
      [requestId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      fingerprint: String(row.fingerprint),
      state: String(row.state) as RequestState,
      actualTokens: row.actual_tokens === null ? null : Number(row.actual_tokens),
      actualUsd: row.actual_usd === null ? null : Number(row.actual_usd),
      outcome: parse(row.outcome)!,
    };
  };

  /** The ring slot a charge lives in: lifetime scopes keep one slot at index 0. */
  const ringIndex = 'CASE WHEN s.window_ms IS NULL THEN 0 ELSE ch.hist END';
  const slot = `((${ringIndex}) % s.buckets) + 1`;
  /** Move a request out of `reserved`, adjusting its ring slots and history by (dt, du). */
  const transition = (next: 'settled' | 'released', dt: string, du: string) => `
    WITH target AS (
      SELECT request_id, model_id, tokens, usd, charges FROM ${t('requests')}
      WHERE request_id = $1 AND state = 'reserved' FOR UPDATE
    ), ch AS (
      SELECT c->>'key' AS key, (c->>'index')::bigint AS hist, tg.model_id,
        ${dt} AS dt, ${du} AS du
      FROM target tg, jsonb_array_elements(tg.charges) AS c
    ), locked AS (
      SELECT s.key FROM ${t('scopes')} s WHERE s.key IN (SELECT key FROM ch) ORDER BY s.key FOR UPDATE
    ), upd AS (
      UPDATE ${t('requests')} r SET state = '${next}'${next === 'settled' ? ', actual_tokens = $2::bigint, actual_usd = $3::float8' : ''}
      FROM target tg WHERE r.request_id = tg.request_id RETURNING r.request_id
    ), ring AS (
      UPDATE ${t('scopes')} s SET
        ring_tokens[${slot}] = s.ring_tokens[${slot}] + ch.dt,
        ring_usd[${slot}] = s.ring_usd[${slot}] + ch.du
      FROM ch WHERE s.key = ch.key AND s.ring_idx[${slot}] = ${ringIndex}
        AND (SELECT count(*) FROM locked) >= 0
      RETURNING s.key
    ), hist AS (
      UPDATE ${t('counters')} k SET tokens = k.tokens + ch.dt, usd = k.usd + ch.du
      FROM ch WHERE k.key = ch.key AND k.bucket = ch.hist AND k.model_id = ch.model_id
      RETURNING k.key
    )
    SELECT (SELECT count(*) FROM upd) AS applied,
      (SELECT count(*) FROM ring) AS ring, (SELECT count(*) FROM hist) AS hist`;

  const settleSql = transition('settled', '$2::bigint - tg.tokens', '$3::float8 - tg.usd');
  const releaseSql = transition('released', '-tg.tokens', '-tg.usd');

  // `cur` holds the scopes whose stored window matches the request. A scope
  // created with another window by a concurrent first reserve drops out of it;
  // then nothing is recorded, `matched` falls short and reserve() answers
  // window_conflict, as it does when it sees the other window up front.
  const reserveSql = `
    WITH now_ms AS (SELECT ${NOW_MS} AS at),
    req AS (
      SELECT r.key, r.lt, r.lu, r.w, r.b, r.ord
      FROM unnest($6::text[], $7::bigint[], $8::float8[], $9::bigint[], $10::int[])
        WITH ORDINALITY AS r(key, lt, lu, w, b, ord)
    ), locked AS (
      SELECT s.key, s.window_ms, s.buckets, s.bucket_ms, s.ring_idx, s.ring_tokens, s.ring_usd
      FROM ${t('scopes')} s WHERE s.key = ANY($6::text[]) ORDER BY s.key FOR UPDATE
    ), cur AS (
      SELECT l.key, q.lt, q.lu, q.ord,
        floor(n.at::numeric / l.bucket_ms)::bigint AS hist,
        CASE WHEN l.window_ms IS NULL THEN 0 ELSE floor(n.at::numeric / l.bucket_ms)::bigint END AS idx,
        l.buckets,
        COALESCE((SELECT sum(x.tok) FROM unnest(l.ring_idx, l.ring_tokens) AS x(i, tok)
          WHERE l.window_ms IS NULL OR x.i > floor(n.at::numeric / l.bucket_ms)::bigint - l.buckets), 0)::bigint AS used_tokens,
        COALESCE((SELECT sum(x.u) FROM unnest(l.ring_idx, l.ring_usd) AS x(i, u)
          WHERE l.window_ms IS NULL OR x.i > floor(n.at::numeric / l.bucket_ms)::bigint - l.buckets), 0)::float8 AS used_usd
      FROM locked l
      JOIN req q ON q.key = l.key AND l.window_ms IS NOT DISTINCT FROM q.w AND l.buckets = q.b
      CROSS JOIN now_ms n
    ), decision AS (
      SELECT (SELECT count(*) FROM cur) = cardinality($6::text[])
        AND NOT EXISTS (
          SELECT 1 FROM cur
          WHERE (lt IS NOT NULL AND used_tokens + $4::bigint > lt)
             OR (lu IS NOT NULL AND round((used_usd + $5::float8)::numeric, 12) > lu::numeric)
        ) AS admitted
    ), failure AS (
      SELECT key, dim, lim, used FROM (
        SELECT key, ord, 0 AS dn, 'tokens' AS dim, lt::float8 AS lim, used_tokens::float8 AS used
        FROM cur WHERE lt IS NOT NULL AND used_tokens + $4::bigint > lt
        UNION ALL
        SELECT key, ord, 1 AS dn, 'usd' AS dim, lu AS lim, used_usd AS used
        FROM cur WHERE lu IS NOT NULL AND round((used_usd + $5::float8)::numeric, 12) > lu::numeric
      ) f ORDER BY ord, dn LIMIT 1
    ), outcome AS (
      SELECT CASE WHEN d.admitted THEN jsonb_build_object(
          'admitted', true,
          'scopes', (SELECT jsonb_agg(jsonb_build_object(
            'key', key, 'tokens', used_tokens + $4::bigint, 'usd', used_usd + $5::float8) ORDER BY ord) FROM cur))
        ELSE (SELECT jsonb_build_object('admitted', false, 'key', key, 'dimension', dim,
          'limit', lim, 'committed', used) FROM failure)
        END AS body
      FROM decision d
    ), ins AS (
      INSERT INTO ${t('requests')}
        (request_id, fingerprint, model_id, tokens, usd, state, charges, outcome, created_at)
      SELECT $1, $2, $3, $4::bigint, $5::float8,
        CASE WHEN d.admitted THEN 'reserved' ELSE 'denied' END,
        (SELECT jsonb_agg(jsonb_build_object('key', key, 'index', hist) ORDER BY ord) FROM cur),
        o.body, n.at
      FROM decision d, outcome o, now_ms n
      WHERE (SELECT count(*) FROM cur) = cardinality($6::text[])
      ON CONFLICT (request_id) DO NOTHING
      RETURNING state, outcome
    ), ring AS (
      UPDATE ${t('scopes')} s SET
        ring_idx[(c.idx % s.buckets) + 1] = c.idx,
        ring_tokens[(c.idx % s.buckets) + 1] =
          CASE WHEN s.ring_idx[(c.idx % s.buckets) + 1] = c.idx
            THEN s.ring_tokens[(c.idx % s.buckets) + 1] ELSE 0 END + $4::bigint,
        ring_usd[(c.idx % s.buckets) + 1] =
          CASE WHEN s.ring_idx[(c.idx % s.buckets) + 1] = c.idx
            THEN s.ring_usd[(c.idx % s.buckets) + 1] ELSE 0 END + $5::float8
      FROM cur c
      WHERE s.key = c.key AND EXISTS (SELECT 1 FROM ins WHERE state = 'reserved')
      RETURNING s.key
    ), hist AS (
      INSERT INTO ${t('counters')} AS k (key, bucket, model_id, tokens, usd)
      SELECT key, hist, $3, $4::bigint, $5::float8 FROM cur
      WHERE EXISTS (SELECT 1 FROM ins WHERE state = 'reserved')
      ON CONFLICT (key, bucket, model_id)
        DO UPDATE SET tokens = k.tokens + excluded.tokens, usd = k.usd + excluded.usd
      RETURNING k.key
    )
    SELECT (SELECT outcome FROM ins) AS outcome, (SELECT count(*) FROM cur) AS matched,
      (SELECT count(*) FROM ring) AS ring, (SELECT count(*) FROM hist) AS hist`;

  const recorded = async (requestId: string, fingerprint: string) => {
    const existing = await readRequest(requestId);
    if (existing && existing.fingerprint !== fingerprint) throw reservationConflict(requestId);
    return existing?.outcome;
  };

  /** Throws window_conflict for a stored scope row whose window differs from the request's. */
  const assertStoredWindows = (
    request: ReturnType<typeof normalizeBudgetReserve>,
    rows: readonly Record<string, unknown>[],
  ): void => {
    for (const row of rows) {
      const scope = request.scopes.find((item) => item.key === row.key);
      if (scope)
        assertSameWindow(scope, {
          windowMs: row.window_ms === null ? null : Number(row.window_ms),
          buckets: Number(row.buckets),
        });
    }
  };
  const readScopes = async (keys: readonly string[]) =>
    (
      await client.query(
        `SELECT key, window_ms, buckets FROM ${t('scopes')} WHERE key = ANY($1::text[])`,
        [keys],
      )
    ).rows;

  return Object.freeze({
    async reserve(input) {
      const request = normalizeBudgetReserve(input);
      await migrate();
      const repeat = await recorded(request.requestId, request.fingerprint);
      if (repeat) return repeat;
      const keys = request.scopes.map((scope) => scope.key);
      // Create missing scope rows; an existing key keeps its first window.
      const { rows: saved } = await client.query(
        `WITH created AS (
          INSERT INTO ${t('scopes')} (key, window_ms, buckets, bucket_ms, ring_idx, ring_tokens, ring_usd)
          SELECT x.key, x.w, x.b, x.bm, array_fill(-1::bigint, ARRAY[x.b]),
            array_fill(0::bigint, ARRAY[x.b]), array_fill(0::float8, ARRAY[x.b])
          FROM unnest($1::text[], $2::bigint[], $3::int[], $4::bigint[]) AS x(key, w, b, bm)
          ON CONFLICT (key) DO NOTHING RETURNING key
        )
        SELECT key, window_ms, buckets FROM ${t('scopes')} WHERE key = ANY($1::text[])`,
        [
          keys,
          request.scopes.map((scope) => scope.windowMs),
          request.scopes.map((scope) => scope.buckets),
          request.scopes.map((scope) => scope.bucketMs),
        ],
      );
      assertStoredWindows(request, saved);
      const { rows } = await client.query(reserveSql, [
        request.requestId,
        request.fingerprint,
        request.modelId,
        request.tokens ?? 0,
        request.usd ?? 0,
        keys,
        request.scopes.map((scope) => scope.limits.tokens ?? null),
        request.scopes.map((scope) => scope.limits.usd ?? null),
        request.scopes.map((scope) => scope.windowMs),
        request.scopes.map((scope) => scope.buckets),
      ]);
      const outcome = parse(rows[0]?.outcome);
      if (outcome) return outcome;
      if (Number(rows[0]?.matched) < keys.length) {
        // A concurrent first reserve created a key with another window after
        // the scope insert above took its snapshot, so that check missed it.
        assertStoredWindows(request, await readScopes(keys));
        throw new Error('Budget reservation found a scope row missing; retry it');
      }
      // A concurrent caller recorded this request first.
      const raced = await recorded(request.requestId, request.fingerprint);
      if (!raced) throw new Error('Budget reservation was not recorded');
      return raced;
    },
    async settle(requestId, actual) {
      assertBudgetKey(requestId);
      const settle = assertBudgetActual(actual);
      await migrate();
      const { rows } = await client.query(settleSql, [requestId, settle.tokens, settle.usd]);
      if (Number(rows[0]?.applied) > 0) return;
      const current = await readRequest(requestId);
      if (current) planBudgetTransition(requestId, current, { settle });
    },
    async release(requestId) {
      assertBudgetKey(requestId);
      await migrate();
      const { rows } = await client.query(releaseSql, [requestId]);
      if (Number(rows[0]?.applied) > 0) return;
      const current = await readRequest(requestId);
      if (!current || planBudgetTransition(requestId, current, { release: true }) === 'noop')
        return;
      // A settled request that cost nothing: nothing to subtract.
      await client.query(
        `UPDATE ${t('requests')} SET state = 'released'
         WHERE request_id = $1 AND state = 'settled' AND actual_tokens = 0 AND actual_usd = 0`,
        [requestId],
      );
    },
    async usage(key, usageOptions = {}) {
      assertUsageOptions(key, usageOptions);
      await migrate();
      // A bucket counts while any part of it lies after `since`.
      const { rows } = await client.query(
        `SELECT k.model_id, sum(k.tokens) AS tokens, sum(k.usd) AS usd
         FROM ${t('counters')} k JOIN ${t('scopes')} s ON s.key = k.key
         WHERE k.key = $1 AND ($2::float8 IS NULL OR k.bucket >= floor($2::float8 / s.bucket_ms))
         GROUP BY k.model_id`,
        [key, usageOptions.since ?? null],
      );
      return summarizeBudgetUsage(
        rows.map((row) => ({
          modelId: String(row.model_id),
          tokens: Number(row.tokens),
          usd: Number(row.usd),
        })),
        usageOptions.byModel,
      );
    },
  } satisfies BudgetStore);
}
