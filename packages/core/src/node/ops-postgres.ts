/**
 * `@deuz-sdk/core/ops/postgres` (2.2): durable leases, native agent run stores
 * and schedule claims on Postgres. Every operation is one SQL statement, so it
 * is atomic on any pooled `PgClientLike`. Lease time is the DATABASE clock,
 * which every process shares; host clocks never decide who holds a lease.
 * Node-only.
 */
import type { PgClientLike } from './store-postgres';
import type { AgentRunEnvelope, AgentRunStore } from '../types/agent-run';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from '../types/lease';
import { assertLeaseRequest } from '../internal/ops-validate';
import { decodeSwarm, encodeSwarm } from '../swarm/store';
import { postgresSchemaName } from './swarm-postgres';
import { postgresSchemaStatement } from './postgres-migrate';

// Persistent budget scopes (2.2, M5) share this Node-only subpath: one import
// for every durable ops store on Postgres.
export { createPostgresBudgetStore } from './budget-postgres';
export type { PostgresBudgetStoreOptions } from './budget-postgres';

export interface PostgresOpsStoreOptions {
  client: PgClientLike;
  /** Schema holding the ops tables. Default `'public'`; must already exist. */
  schema?: string;
}

export interface PostgresOpsStore {
  leases: LeaseProvider;
  agentRuns: AgentRunStore;
  /**
   * A durable claim for `createScheduler({ claim })` and `handleSignal({ dedupe })`:
   * a key is granted once across every process using the schema, until
   * `release(key)` gives it back. Granted keys stay in `deuz_claims` (with
   * `claimed_at`, epoch ms on the database clock) until you delete them; a key
   * over 512 characters or holding a NUL is stored as `sha256:<hex>` of it.
   */
  claims: { (key: string): Promise<boolean>; release(key: string): Promise<void> };
}

const SCHEMA_VERSION = 1;
const SIGNALS: readonly LeaseSignal[] = ['cancel', 'drain'];
/** Milliseconds on the database clock. */
const NOW = `(extract(epoch from clock_timestamp()) * 1000)::bigint`;
const encoder = new TextEncoder();

/**
 * The key a claim row stores: the key itself, or `sha256:` and the hex SHA-256
 * of it when it is longer than 512 characters or holds a NUL. Postgres text
 * rejects a NUL (22021) and the btree index a row over 2704 bytes (54000); 512
 * characters is at most 1536 UTF-8 bytes. The SQLite claims map keys the same way.
 */
async function claimRowKey(key: string): Promise<string> {
  if (key.length <= 512 && !key.includes('\0')) return key;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

type Row = Record<string, unknown>;

export function createPostgresOpsStore(options: PostgresOpsStoreOptions): PostgresOpsStore {
  const schema = postgresSchemaName(options.schema);
  const leasesTable = `${schema}.deuz_leases`;
  const runsTable = `${schema}.deuz_agent_runs`;
  const claimsTable = `${schema}.deuz_claims`;
  const meta = `${schema}.deuz_ops_schema`;
  const query = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await options.client.query(sql, params)).rows;

  let ready: Promise<void> | undefined;
  // One statement (a DO block) under an advisory lock: see postgres-migrate.ts.
  const schemaSql = postgresSchemaStatement({
    lock: `ops:${schema}`,
    meta,
    version: SCHEMA_VERSION,
    unsupported: 'Unsupported Postgres ops schema version',
    create: [
      `CREATE TABLE IF NOT EXISTS ${leasesTable} (
      key TEXT PRIMARY KEY, owner TEXT NOT NULL, token BIGINT NOT NULL,
      expires_at BIGINT NOT NULL, signals JSONB NOT NULL DEFAULT '[]'::jsonb)`,
      `CREATE TABLE IF NOT EXISTS ${runsTable} (
      run_id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision BIGINT NOT NULL,
      payload TEXT NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${claimsTable} (key TEXT PRIMARY KEY, claimed_at BIGINT NOT NULL)`,
    ],
  });
  const migrate = async (): Promise<void> => {
    await query(schemaSql);
  };
  const use = async (): Promise<void> => {
    ready ??= migrate().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    await ready;
  };
  const view = (key: string, owner: string, token: unknown, expiresAt: unknown): Lease =>
    Object.freeze({ key, owner, token: Number(token), expiresAt: Number(expiresAt) });

  const leases: LeaseProvider = {
    async acquire({ key, owner, ttlMs }) {
      assertLeaseRequest(key, owner, ttlMs);
      await use();
      // Free, released (expires_at 0) or expired keys change hands; tokens only grow.
      // A queued cancel concerns the run and outlives its holder (2.2); a drain does not.
      const [row] = await query(
        `INSERT INTO ${leasesTable} AS l (key, owner, token, expires_at, signals)
        VALUES ($1, $2, 1, ${NOW} + $3, '[]'::jsonb)
        ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, token = l.token + 1,
          expires_at = EXCLUDED.expires_at,
          signals = CASE WHEN l.signals @> '["cancel"]'::jsonb
            THEN '["cancel"]'::jsonb ELSE '[]'::jsonb END
        WHERE l.expires_at <= ${NOW}
        RETURNING token, expires_at`,
        [key, owner, ttlMs],
      );
      return row ? view(key, owner, row.token, row.expires_at) : undefined;
    },
    async renew(lease, ttlMs): Promise<LeaseRenewal> {
      assertLeaseRequest(lease.key, lease.owner, ttlMs);
      await use();
      // The locked read returns the signals this renewal consumes.
      const [row] = await query(
        `UPDATE ${leasesTable} l SET expires_at = ${NOW} + $4, signals = '[]'::jsonb
        FROM (SELECT key, signals FROM ${leasesTable} WHERE key = $1 FOR UPDATE) AS old
        WHERE l.key = old.key AND l.owner = $2 AND l.token = $3 AND l.expires_at <> 0
        RETURNING l.expires_at, old.signals::text AS signals`,
        [lease.key, lease.owner, lease.token, ttlMs],
      );
      if (!row) return { held: false };
      return {
        held: true,
        lease: view(lease.key, lease.owner, lease.token, row.expires_at),
        signals: JSON.parse(String(row.signals)) as LeaseSignal[],
      };
    },
    async release(lease) {
      await use();
      await query(
        `UPDATE ${leasesTable} SET expires_at = 0,
          signals = CASE WHEN signals @> '["cancel"]'::jsonb
            THEN '["cancel"]'::jsonb ELSE '[]'::jsonb END
        WHERE key = $1 AND token = $2 AND owner = $3`,
        [lease.key, lease.token, lease.owner],
      );
    },
    async signal(key, signal) {
      if (!SIGNALS.includes(signal)) throw new TypeError(`Unknown lease signal: ${String(signal)}`);
      await use();
      const rows = await query(
        `UPDATE ${leasesTable} SET signals = CASE
          WHEN signals @> jsonb_build_array($2::text) THEN signals
          ELSE signals || jsonb_build_array($2::text) END
        WHERE key = $1 AND expires_at > ${NOW}
        RETURNING 1 AS held`,
        [key, signal],
      );
      return rows.length === 1;
    },
  };

  const agentRuns: AgentRunStore = {
    async load(runId) {
      await use();
      const [row] = await query(`SELECT payload FROM ${runsTable} WHERE run_id = $1`, [runId]);
      return row ? decodeSwarm<AgentRunEnvelope>(String(row.payload)) : undefined;
    },
    async save(envelope) {
      if (!envelope?.runId) throw new TypeError('Agent run envelopes require a runId');
      const revision = envelope.revision;
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
        throw new Error(`Agent run revision conflict for ${envelope.runId}: invalid revision`);
      const payload = encodeSwarm(envelope);
      await use();
      // Column revision 0 is a 2.1 envelope. A new run starts at 1 (or 0 for a
      // 2.1 write); an existing one advances by exactly one.
      const rows = await query(
        `INSERT INTO ${runsTable} AS r (run_id, scope, revision, payload, updated_at)
        SELECT $1, $2, $3::bigint, $4, ${NOW}
        WHERE $3::bigint <= 1 OR EXISTS (SELECT 1 FROM ${runsTable} WHERE run_id = $1)
        ON CONFLICT (run_id) DO UPDATE SET scope = EXCLUDED.scope, revision = EXCLUDED.revision,
          payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
        WHERE r.revision = EXCLUDED.revision - 1 OR (EXCLUDED.revision = 0 AND r.revision = 0)
        RETURNING 1 AS saved`,
        [envelope.runId, envelope.scope, revision ?? 0, payload],
      );
      if (rows.length !== 1)
        throw new Error(
          `Agent run revision conflict for ${envelope.runId}: revision ${String(revision)} is not the next one`,
        );
    },
  };

  const claims: PostgresOpsStore['claims'] = Object.assign(
    async (key: string): Promise<boolean> => {
      const row = await claimRowKey(key);
      await use();
      // One statement: whichever session inserts the key first wins it.
      const rows = await query(
        `INSERT INTO ${claimsTable} (key, claimed_at) VALUES ($1, ${NOW})
        ON CONFLICT (key) DO NOTHING RETURNING 1 AS claimed`,
        [row],
      );
      return rows.length === 1;
    },
    {
      async release(key: string): Promise<void> {
        const row = await claimRowKey(key);
        await use();
        await query(`DELETE FROM ${claimsTable} WHERE key = $1`, [row]);
      },
    },
  );

  return { leases, agentRuns, claims };
}
