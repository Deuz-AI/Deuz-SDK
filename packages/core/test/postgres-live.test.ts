/**
 * The Postgres stores on a real server (2.3, F23). PGlite, which the offline
 * suite uses, has a single connection, so no statement there ever waits for
 * another. Here a `pg` pool of several connections runs every statement under
 * REPEATABLE READ: concurrent writes really contend, a loser really fails with
 * 40001, and the stores' retries really run.
 *
 * Runs only when DEUZ_TEST_POSTGRES_URL names a database the test may create
 * and drop schemas in; the CI `integration` job sets it, with a postgres:16
 * service. Without it every test here is skipped. Locally:
 *
 *   docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=deuz -e POSTGRES_DB=deuz postgres:16
 *   DEUZ_TEST_POSTGRES_URL=postgres://postgres:deuz@localhost:5432/deuz \
 *     npm run test -w @deuz-sdk/core -- test/postgres-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import { createPostgresBudgetStore } from '../src/node/budget-postgres';
import { createPostgresSwarmStore } from '../src/node/swarm-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import { BudgetStoreError } from '../src/budget-store';
import { SwarmConflictError } from '../src/swarm';
import type { SwarmStore } from '../src/types/swarm';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';
import {
  agentRunPruneContracts,
  agentRunStoreContracts,
} from './fixtures/agent-run-store-conformance';
import {
  scheduleClaimContracts,
  scheduleClaimPruneContracts,
} from './fixtures/schedule-claim-conformance';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';
import { initialSnapshot, swarmStoreContracts } from './fixtures/swarm-store-conformance';

const url = process.env.DEUZ_TEST_POSTGRES_URL || undefined;
// A network round trip per statement, and real waits for database time.
if (url) vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
/** Enough for the contention cases below plus a connection to watch them with. */
const POOL_SIZE = 6;
const REPEATABLE_READ =
  'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ';

let pool: pg.Pool | undefined;
/** What the pool reported outside a query: a failed session setup, an idle connection's error. */
const poolErrors: unknown[] = [];
/** Database clock minus host clock, so `now()` reads the stores' own time. */
let skew = 0;
const now = (): number => Date.now() + skew;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The stores' view of the pool: one statement per call, on whichever connection is free. */
const client: PgClientLike = {
  async query(sql, params) {
    if (!pool) throw new Error('The live Postgres pool is not open');
    const result = await pool.query(sql, params);
    return { rows: result.rows as Record<string, unknown>[] };
  },
};

// One prefix per run: schemas from an earlier, interrupted run never collide.
const prefix = `deuz_live_${Date.now().toString(36)}`;
const schemas: string[] = [];
const schemaName = (): string => {
  const name = `${prefix}_${schemas.length + 1}`;
  schemas.push(name);
  return name;
};
async function freshSchema(): Promise<string> {
  const name = schemaName();
  await client.query(`CREATE SCHEMA ${name}`);
  return name;
}
const freshOps = async () => createPostgresOpsStore({ client, schema: await freshSchema() });

/** The swarm contract makes stores synchronously: the schema is created on first use. */
function freshSwarmStore(): SwarmStore {
  const schema = schemaName();
  let created: Promise<unknown> | undefined;
  return createPostgresSwarmStore({
    schema,
    client: {
      async query(sql, params) {
        created ??= client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        await created;
        return client.query(sql, params);
      },
    },
  });
}

describe.skipIf(!url)('Postgres stores on a live server (REPEATABLE READ, pooled)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: POOL_SIZE });
    // A new connection runs this before any statement the pool hands it.
    pool.on('connect', (connection) => {
      connection.query(REPEATABLE_READ).catch((error: unknown) => poolErrors.push(error));
    });
    pool.on('error', (error) => poolErrors.push(error));
    const sent = Date.now();
    const { rows } = await pool.query<{ at: number }>(
      'SELECT extract(epoch from clock_timestamp())::float8 * 1000 AS at',
    );
    skew = Number(rows[0]!.at) - (sent + Date.now()) / 2;
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
      pool = undefined;
    }
  });

  it('runs every pooled connection at REPEATABLE READ', async () => {
    const connections = await Promise.all(Array.from({ length: POOL_SIZE }, () => pool!.connect()));
    try {
      for (const connection of connections) {
        const { rows } = await connection.query<{ transaction_isolation: string }>(
          'SHOW transaction_isolation',
        );
        expect(rows[0]!.transaction_isolation).toBe('repeatable read');
      }
    } finally {
      for (const connection of connections) connection.release();
    }
    expect(poolErrors).toEqual([]);
  });

  leaseProviderContracts('lease provider', async () => ({
    provider: (await freshOps()).leases,
    advance: wait,
    ttl: 500,
    now,
  }));
  agentRunStoreContracts('agent run store', async () => (await freshOps()).agentRuns);
  agentRunPruneContracts('agent run retention', async () => ({
    store: (await freshOps()).agentRuns,
    advance: wait,
    now,
  }));
  scheduleClaimContracts('claim', async () => (await freshOps()).claims);
  scheduleClaimPruneContracts('claim retention', async () => ({
    claim: (await freshOps()).claims,
    advance: wait,
    now,
  }));
  budgetStoreContracts('budget store', async () => ({
    store: createPostgresBudgetStore({ client, schema: await freshSchema() }),
    advance: wait,
    now,
  }));
  swarmStoreContracts('swarm store', () => freshSwarmStore(), {
    spawn: true,
    channels: true,
    list: true,
    prune: true,
  });

  describe('contention', () => {
    it('runs a write again after a real serialization failure', async () => {
      const schema = await freshSchema();
      const failures: unknown[] = [];
      const watched: PgClientLike = {
        async query(sql, params) {
          try {
            return await client.query(sql, params);
          } catch (error) {
            failures.push((error as { code?: unknown }).code);
            throw error;
          }
        },
      };
      const ops = createPostgresOpsStore({ client: watched, schema });
      const lease = (await ops.leases.acquire({ key: 'k', owner: 'a', ttlMs: 60_000 }))!;
      const blocker = await pool!.connect();
      try {
        // Another transaction changes the row and keeps it locked.
        await blocker.query('BEGIN');
        await blocker.query(`UPDATE ${schema}.deuz_leases SET signals = signals WHERE key = 'k'`);
        const renewal = ops.leases.renew(lease, 60_000);
        renewal.catch(() => undefined); // awaited below, unless the wait fails first
        // The renewal took its snapshot and now waits for that lock.
        for (let polls = 0; ; polls++) {
          const { rows } = await client.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query LIKE $1`,
            [`%${schema}.deuz_leases%`],
          );
          if (Number(rows[0]!.n) > 0) break;
          if (polls > 500) throw new Error('The renewal never waited for the lock');
          await wait(10);
        }
        await blocker.query('COMMIT');
        // Its snapshot predates the commit: 40001, then a second attempt that succeeds.
        expect(await renewal).toMatchObject({ held: true, lease: { token: 1 } });
      } finally {
        // Discarded, not returned: a failed step may have left it inside the transaction.
        blocker.release(true);
      }
      expect(failures).toEqual(['40001']);
    });

    it('gives a contended key to exactly one holder, with tokens that only grow', async () => {
      const ops = await freshOps();
      const owners = Array.from({ length: 8 }, (_, index) => `exec-${index}`);
      const acquireAll = (key: string) =>
        owners.map((owner) => ops.leases.acquire({ key, owner, ttlMs: 60_000 }));
      let token = 0;
      for (let round = 0; round < 3; round++) {
        const held = (await Promise.all(acquireAll('swarm:k'))).filter((lease) => lease);
        expect(held).toHaveLength(1);
        const lease = held[0]!;
        expect(lease.token).toBeGreaterThan(token);
        token = lease.token;
        // The holder renews while every owner tries again: it keeps the key.
        const [renewal, ...others] = await Promise.all([
          ops.leases.renew(lease, 60_000),
          ...acquireAll('swarm:k'),
        ]);
        expect(renewal).toMatchObject({ held: true, lease: { token } });
        expect(others.filter((other) => other)).toEqual([]);
        await ops.leases.release(lease);
      }

      // A lapsed lease nobody took: its holder renews it, or one owner takes it over, never both.
      const lapsed = (await ops.leases.acquire({ key: 'swarm:l', owner: 'old', ttlMs: 300 }))!;
      await wait(600);
      const [renewal, ...takers] = await Promise.all([
        ops.leases.renew(lapsed, 60_000),
        ...acquireAll('swarm:l'),
      ]);
      const taken = takers.filter((lease) => lease);
      expect((renewal.held ? 1 : 0) + taken.length).toBe(1);
      const [taker] = taken;
      if (taker) expect(taker.token).toBe(lapsed.token + 1);
    });

    it('grants a contended claim to exactly one caller', async () => {
      const ops = await freshOps();
      for (let round = 0; round < 3; round++) {
        const granted = await Promise.all(
          Array.from({ length: 12 }, () => ops.claims(`delivery-${round}`)),
        );
        expect(granted.filter(Boolean)).toHaveLength(1);
      }
      // Distinct keys never hold each other up.
      const distinct = await Promise.all(
        Array.from({ length: 12 }, (_, index) => ops.claims(`job-${index}`)),
      );
      expect(distinct.every(Boolean)).toBe(true);
    });

    it('creates a run once and commits exactly one of several racing writers', async () => {
      const store = freshSwarmStore();
      const snapshot = initialSnapshot();
      const created = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]),
        ),
      );
      expect(created.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of created)
        if (outcome.status === 'rejected')
          expect(outcome.reason).toBeInstanceOf(SwarmConflictError);

      for (let revision = 0; revision < 3; revision++) {
        const writers = await Promise.allSettled(
          Array.from({ length: 6 }, (_, writer) =>
            store.commit({
              scope: snapshot.run.scope,
              runId: snapshot.run.runId,
              expectedRevision: revision,
              tasks: [
                { ...snapshot.tasks[0]!, status: 'running', attempt: revision * 10 + writer + 1 },
              ],
              events: [{ type: 'task.started', taskId: 'a', timestamp: 2 + revision }],
            }),
          ),
        );
        const won = writers.flatMap((outcome, writer) =>
          outcome.status === 'fulfilled' ? [writer] : [],
        );
        expect(won).toHaveLength(1);
        for (const outcome of writers)
          if (outcome.status === 'rejected')
            expect(outcome.reason).toBeInstanceOf(SwarmConflictError);
        const after = await store.load(snapshot.run);
        expect(after?.run).toMatchObject({ revision: revision + 1, lastSequence: revision + 2 });
        expect(after?.tasks[0]?.attempt).toBe(revision * 10 + won[0]! + 1);
      }
      expect((await store.readEvents(snapshot.run, 0, 10)).map((event) => event.type)).toEqual([
        'run.started',
        'task.started',
        'task.started',
        'task.started',
      ]);
    });

    it('never admits past a limit when reservations race across overlapping scopes', async () => {
      const store = createPostgresBudgetStore({ client, schema: await freshSchema() });
      const org = { key: 'org:live', limits: { tokens: 90 } };
      const team = (key: string) => ({ key, limits: { tokens: 1_000 } });
      // The scope rows exist before the race, as they do for any scope in use.
      await store.reserve({
        requestId: 'warm-a',
        modelId: 'm',
        tokens: 0,
        scopes: [team('team:a'), org],
      });
      await store.reserve({
        requestId: 'warm-b',
        modelId: 'm',
        tokens: 0,
        scopes: [org, team('team:b')],
      });
      // Twelve 30-token calls that the org can admit three of. They name their
      // scopes in either order; admission locks scopes in key order, so two
      // admissions never deadlock.
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.reserve({
            requestId: `r${index}`,
            modelId: 'm',
            tokens: 30,
            scopes: index % 2 ? [org, team('team:b')] : [team('team:a'), org],
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(3);
      for (const outcome of outcomes)
        if (!outcome.admitted)
          expect(outcome).toMatchObject({ key: 'org:live', limit: 90, committed: 90 });
      expect(await store.usage('org:live')).toEqual({ tokens: 90, usd: 0 });
      const teams = (await store.usage('team:a')).tokens + (await store.usage('team:b')).tokens;
      expect(teams).toBe(90);
    });

    it('bills each hold once when its caller, a sweep and a prune race', async () => {
      const store = createPostgresBudgetStore({ client, schema: await freshSchema() });
      // One scope per hold, so only the parties racing for the same hold contend.
      const scope = (index: number) => ({ key: `user:race-${index}`, limits: { tokens: 1_000 } });
      const holds = [0, 1, 2, 3, 4, 5];
      // Finished records from before `cut`, which the prune deletes during the race.
      for (const index of holds) {
        await store.reserve({
          requestId: `done-${index}`,
          modelId: 'm',
          tokens: 5,
          scopes: [scope(index)],
        });
        await store.settle(`done-${index}`, { tokens: 5, usd: 0 });
      }
      await wait(20);
      const cut = now();
      await wait(20);
      for (const index of holds)
        await store.reserve({
          requestId: `hold-${index}`,
          modelId: 'm',
          tokens: 50,
          scopes: [scope(index)],
        });

      // Each caller settles its hold for 10 tokens, or releases it, while a
      // sweep bills every stale hold its 50-token estimate.
      const releases = (index: number) => index % 3 === 2;
      const [swept, pruned, ...callers] = await Promise.allSettled([
        store.sweep({ before: now() + 60_000 }),
        store.prune({ before: cut }),
        ...holds.map((index) =>
          releases(index)
            ? store.release(`hold-${index}`)
            : store.settle(`hold-${index}`, { tokens: 10, usd: 0 }),
        ),
      ]);
      expect(pruned).toMatchObject({ status: 'fulfilled', value: { requests: 6 } });
      expect(swept.status).toBe('fulfilled');
      let billedBySweep = 0;
      for (const index of holds) {
        const caller = callers[index]!;
        const { tokens } = await store.usage(`user:race-${index}`);
        if (caller.status === 'fulfilled') {
          // The caller closed its hold first; the sweep skipped it.
          expect(tokens).toBe(5 + (releases(index) ? 0 : 10));
        } else {
          // The sweep billed the estimate first, so the caller's close conflicts.
          expect(caller.reason).toBeInstanceOf(BudgetStoreError);
          expect(caller.reason).toMatchObject({ code: 'reservation_conflict' });
          expect(tokens).toBe(5 + 50);
          billedBySweep++;
        }
      }
      if (swept.status === 'fulfilled') expect(swept.value.settled).toBe(billedBySweep);
      expect(await store.holds({ before: now() + 60_000 })).toEqual([]);
    });
  });
});
