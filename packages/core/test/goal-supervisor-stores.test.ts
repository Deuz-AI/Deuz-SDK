/**
 * The goal supervisor on every goal runtime store adapter (2.4, spec §3.1):
 * the same flows on the in-memory store, SQLite (`:memory:`), PGlite and,
 * when DEUZ_TEST_POSTGRES_URL is set, a live PostgreSQL server (a schema of
 * its own per test, dropped afterwards): one executor per goal, a resume with
 * verdicts and client results that survives as JSON, a retry carrying them,
 * a cancel for an idle run, an inbox entry settled with its run intent, and
 * ledger differences charged once.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGoalEvent } from '../src/goal';
import { createGoalSupervisor, createInMemoryGoalRuntimeStore } from '../src/goal/runtime';
import type { GoalRuntimeStore } from '../src/goal/runtime';
import { createPostgresGoalRuntimeStore } from '../src/node/goal-runtime-postgres';
import { createSqliteGoalRuntimeStore } from '../src/node/goal-runtime-sqlite';
import { createInMemoryLeaseProvider } from '../src/ops';
import type { Clock } from '../src/types/deps';
import { fakeRunLauncher, results, totals } from './fixtures/fake-run-launcher';
import type { FakeRunLauncher } from './fixtures/fake-run-launcher';
import { manualClock } from './fixtures/manual-clock';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const T0 = Date.parse('2026-10-15T09:00:00Z');
const SCOPE = 'tenant-a';

type MakeStore = (clock: Clock) => Promise<{ store: GoalRuntimeStore; close(): Promise<void> }>;

function supervisorFlows(name: string, make: MakeStore): void {
  describe(`goal supervisor on ${name}`, () => {
    async function world() {
      const time = manualClock(T0);
      const { store, close } = await make(time.clock);
      const provider = createInMemoryLeaseProvider({ clock: time.clock });
      const supervisorFor = (owner: string, launcher: FakeRunLauncher) =>
        createGoalSupervisor({
          store,
          launcher,
          lease: { provider, owner },
          deps: { clock: time.clock },
        });
      return { time, store, close, supervisorFor };
    }

    it('drives a goal with one executor', async () => {
      const w = await world();
      try {
        const launcher = fakeRunLauncher(() => 'hold');
        const a = w.supervisorFor('sup-a', launcher);
        const b = w.supervisorFor('sup-b', launcher);
        await a.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
        const ticks = [a.tick(), b.tick()];
        // If both ticks end without holding a leg (one threw, say), fail with
        // what they returned instead of waiting out the test timeout.
        const noLeg = Promise.allSettled(ticks).then((settled) => {
          throw new Error(
            `no leg was held: ${JSON.stringify(
              settled.map((s) => (s.status === 'rejected' ? String(s.reason) : s.value)),
            )}`,
          );
        });
        // Once the held leg finishes the ticks settle too: that rejection is expected.
        noLeg.catch(() => undefined);
        (await Promise.race([launcher.whenHeld(), noLeg])).finish({
          runId: 'g:run:1',
          result: results.completed('g:run:1'),
        });
        const [first, second] = await Promise.all(ticks);
        expect(first!.dispatched + second!.dispatched).toBe(1);
        expect(launcher.calls).toHaveLength(1);
      } finally {
        await w.close();
      }
    });

    it('resumes with stored verdicts and client results, and retries with them', async () => {
      const w = await world();
      try {
        const launcher = fakeRunLauncher((request, kind) => {
          if (kind === 'launch')
            return { runId: request.runId, result: results.suspended(request.runId) };
          if (request.kind === 'resume')
            return {
              runId: request.runId,
              result: results.failed(request.runId, 'overloaded'),
              retryable: true,
            };
          return { runId: request.runId, result: results.completed(request.runId) };
        });
        launcher.ledger.set('g:run:1', totals({ tokens: 10, usd: 0.5 }, { tokens: 4, usd: 0.25 }));
        const supervisor = w.supervisorFor('sup-a', launcher);
        await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
        await supervisor.tick();
        const approvalResponses = [{ approvalId: 'ap-1', approved: true }];
        const clientToolResults = [{ toolCallId: 'c-1', output: { rows: [1, 2] }, isError: false }];
        await supervisor.resume(SCOPE, 'g', { approvalResponses, clientToolResults });
        await supervisor.tick();
        await w.time.advance(1_000);
        await supervisor.tick();
        expect(
          launcher.calls.map((call) => [
            call.request.kind,
            call.request.approvalResponses,
            call.request.clientToolResults,
          ]),
        ).toEqual([
          ['start', undefined, undefined],
          ['resume', approvalResponses, clientToolResults],
          ['retry', approvalResponses, clientToolResults],
        ]);
        // Charged once over three legs of the same run; the reservation is never charged.
        expect((await w.store.load('g'))?.spent).toEqual({ tokens: 10, usd: 0.5 });
        expect(await w.store.watermarks.get(SCOPE, 'g', 'g:run:1')).toMatchObject({
          tokens: 10,
          reservedTokens: 4,
          revision: 1,
        });
      } finally {
        await w.close();
      }
    });

    it('applies a cancel recorded for an idle run at the next claim', async () => {
      const w = await world();
      try {
        const launcher = fakeRunLauncher((request) => ({
          runId: request.runId,
          result: results.suspended(request.runId),
        }));
        const supervisor = w.supervisorFor('sup-a', launcher);
        await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
        await supervisor.tick();
        await supervisor.command(SCOPE, 'g', { type: 'cancel', reason: 'stop' });
        const next = w.supervisorFor('sup-b', fakeRunLauncher());
        expect(await next.tick()).toMatchObject({ cancelled: 1, dispatched: 0 });
        expect(await next.get(SCOPE, 'g')).toMatchObject({
          goal: { status: 'cancelled' },
          runtime: { phase: 'done', cancel: { reason: 'stop', appliedAt: T0 } },
        });
      } finally {
        await w.close();
      }
    });

    it('settles an inbox entry with the run intent it starts', async () => {
      const w = await world();
      try {
        const launcher = fakeRunLauncher();
        const supervisor = w.supervisorFor('sup-a', launcher);
        await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x', start: false });
        await supervisor.command(SCOPE, 'g', {
          type: 'wait',
          wait: { reason: 'event', source: { type: 'signal', id: 'ci' } },
        });
        const { entry } = await supervisor.dispatch(
          createGoalEvent({
            scope: SCOPE,
            goalId: 'g',
            source: { type: 'signal', id: 'ci' },
            key: 'build-1',
            at: T0,
          }),
          { namespace: 'webhook:ci' },
        );
        expect(await supervisor.tick()).toMatchObject({ applied: 1, dispatched: 1 });
        const settled = await w.store.inbox.get(SCOPE, entry.id);
        expect(settled?.disposition).toBe('applied');
        expect(await w.store.intents.get(SCOPE, settled!.intentId!)).toMatchObject({
          status: 'completed',
          cause: { inboxEntryId: entry.id },
        });
      } finally {
        await w.close();
      }
    });
  });
}

supervisorFlows('the in-memory store', async (clock) => ({
  store: createInMemoryGoalRuntimeStore({ deps: { clock } }),
  close: async () => {},
}));

supervisorFlows('SQLite', async (clock) => {
  const store = createSqliteGoalRuntimeStore({ path: ':memory:', clock });
  return { store, close: () => store.close() };
});

const lite = new PGlite();
const litePool = pglitePool(lite);
let liteSchemas = 0;
beforeAll(() => lite.waitReady, SLOW_HOOK_TIMEOUT_MS);
afterAll(() => lite.close());

supervisorFlows('PGlite', async (clock) => {
  const schema = `goal_sup_${++liteSchemas}`;
  await litePool.query(`CREATE SCHEMA ${schema}`);
  const store = createPostgresGoalRuntimeStore({ pool: litePool, schema, clock });
  return { store, close: () => store.close() };
});

const url = postgresUrl();
if (url) vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!url)('live PostgreSQL', () => {
  let pool: pg.Pool;
  // One prefix per run, and only the schemas this file created are dropped.
  const prefix = `deuz_l4b_sup_${Date.now().toString(36)}`;
  const schemas: string[] = [];

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  supervisorFlows('a live PostgreSQL server', async (clock) => {
    const schema = `${prefix}_${schemas.length + 1}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${schema}`);
    const store = createPostgresGoalRuntimeStore({ pool, schema, clock });
    return { store, close: () => store.close() };
  });
});
