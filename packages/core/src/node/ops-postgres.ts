/**
 * `@deuz-sdk/core/ops/postgres` (2.2): durable leases and native agent run
 * stores on Postgres. Every operation is one SQL statement, so it is atomic on
 * any pooled `PgClientLike`. Lease time is the DATABASE clock, which every
 * process shares; host clocks never decide who holds a lease. Node-only.
 */
import type { PgClientLike } from './store-postgres';
import type { AgentRunEnvelope, AgentRunStore } from '../types/agent-run';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from '../types/lease';
import { assertLeaseRequest } from '../internal/ops-validate';
import { decodeSwarm, encodeSwarm } from '../swarm/store';
import { postgresSchemaName } from './swarm-postgres';

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
}

const SCHEMA_VERSION = 1;
const SIGNALS: readonly LeaseSignal[] = ['cancel', 'drain'];
/** Milliseconds on the database clock. */
const NOW = `(extract(epoch from clock_timestamp()) * 1000)::bigint`;

type Row = Record<string, unknown>;

export function createPostgresOpsStore(options: PostgresOpsStoreOptions): PostgresOpsStore {
  const schema = postgresSchemaName(options.schema);
  const leasesTable = `${schema}.deuz_leases`;
  const runsTable = `${schema}.deuz_agent_runs`;
  const meta = `${schema}.deuz_ops_schema`;
  const query = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await options.client.query(sql, params)).rows;

  let ready: Promise<void> | undefined;
  const migrate = async (): Promise<void> => {
    await query(
      `CREATE TABLE IF NOT EXISTS ${meta} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)`,
    );
    await query(
      `INSERT INTO ${meta} (singleton, version) VALUES (1, ${SCHEMA_VERSION}) ON CONFLICT (singleton) DO NOTHING`,
    );
    const [row] = await query(`SELECT version FROM ${meta} WHERE singleton = 1`);
    if (Number(row?.version) !== SCHEMA_VERSION)
      throw new Error('Unsupported Postgres ops schema version');
    await query(`CREATE TABLE IF NOT EXISTS ${leasesTable} (
      key TEXT PRIMARY KEY, owner TEXT NOT NULL, token BIGINT NOT NULL,
      expires_at BIGINT NOT NULL, signals JSONB NOT NULL DEFAULT '[]'::jsonb)`);
    await query(`CREATE TABLE IF NOT EXISTS ${runsTable} (
      run_id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision BIGINT NOT NULL,
      payload TEXT NOT NULL, updated_at BIGINT NOT NULL)`);
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
      const [row] = await query(
        `INSERT INTO ${leasesTable} AS l (key, owner, token, expires_at, signals)
        VALUES ($1, $2, 1, ${NOW} + $3, '[]'::jsonb)
        ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, token = l.token + 1,
          expires_at = EXCLUDED.expires_at, signals = '[]'::jsonb
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
        `UPDATE ${leasesTable} SET expires_at = 0, signals = '[]'::jsonb
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

  return { leases, agentRuns };
}
