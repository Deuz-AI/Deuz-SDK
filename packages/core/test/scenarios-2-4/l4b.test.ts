/**
 * L4B acceptance scenarios (new.txt §3.1, §5.1 "Goal supervisor"): one
 * executor per goal, a cancel for an idle run applied after a restart, drain
 * to a safe checkpoint, a retry carrying the stored approval verdict, ledger
 * differences charged once across a crash, and a drain on goal lease loss.
 * The supervisor runs on the SQLite goal runtime store (a file where a
 * restart is the point) with a scripted `RunLauncher`; each scenario builds
 * its own stores, clock and launcher.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { GoalCommand } from '../../src/goal';
import { createGoalSupervisor } from '../../src/goal/runtime';
import type {
  GoalRuntimeStore,
  GoalSupervisorEvent,
  GoalSupervisorOptions,
} from '../../src/goal/runtime';
import { createSqliteGoalRuntimeStore } from '../../src/node/goal-runtime-sqlite';
import { createInMemoryLeaseProvider } from '../../src/ops';
import type { LeaseProvider } from '../../src/types/lease';
import type { ObserveEvent } from '../../src/types/observe';
import { fakeRunLauncher, results, totals } from '../fixtures/fake-run-launcher';
import type { FakeRunLauncher } from '../fixtures/fake-run-launcher';
import { manualClock } from '../fixtures/manual-clock';
import { SLOW_TEST_TIMEOUT_MS } from '../fixtures/timeouts';
import { scenario } from './registry';

const T0 = Date.parse('2026-10-15T09:00:00Z');
const SCOPE = 'tenant-a';

async function databaseFile(): Promise<{ path: string; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'deuz-l4b-'));
  return {
    path: join(directory, 'goals.sqlite'),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

/** A supervisor over `store`, with what it emitted. */
function supervise(
  store: GoalRuntimeStore,
  provider: LeaseProvider,
  time: ReturnType<typeof manualClock>,
  options: Partial<GoalSupervisorOptions> & { owner: string; launcher: FakeRunLauncher },
) {
  const { owner, ...rest } = options;
  const seen: GoalSupervisorEvent[] = [];
  const observed: ObserveEvent[] = [];
  const supervisor = createGoalSupervisor({
    store,
    lease: { provider, owner },
    deps: { clock: time.clock, observer: { emit: (event) => void observed.push(event) } },
    ...rest,
  });
  const controller = new AbortController();
  void (async () => {
    for await (const event of supervisor.events({ signal: controller.signal })) seen.push(event);
  })();
  return { supervisor, seen, observed };
}

const spans = (observed: ObserveEvent[], name: string) =>
  observed.filter(
    (event) =>
      event.type === 'operation.completed' && 'operation' in event && event.operation === name,
  );

scenario(
  'supervisor',
  'claim-single-executor',
  async () => {
    // Two supervisors tick the same goal at the same moment: one claims the
    // goal lease and launches its run once; the other skips it.
    const time = manualClock(T0);
    const store = createSqliteGoalRuntimeStore({ path: ':memory:', clock: time.clock });
    try {
      const provider = createInMemoryLeaseProvider({ clock: time.clock });
      const launcher = fakeRunLauncher(() => 'hold');
      const a = supervise(store, provider, time, { owner: 'sup-a', launcher });
      const b = supervise(store, provider, time, { owner: 'sup-b', launcher });
      await a.supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'Ship the report.' });
      const ticks = [a.supervisor.tick(), b.supervisor.tick()];
      const leg = await launcher.whenHeld();
      leg.finish({ runId: 'g:run:1', result: results.completed('g:run:1') });
      const [first, second] = await Promise.all(ticks);
      expect(first!.dispatched + second!.dispatched).toBe(1);
      expect(first!.skipped + second!.skipped).toBe(1);
      expect(launcher.calls).toHaveLength(1);
      const intent = await store.intents.get(SCOPE, 'g#1');
      expect(intent).toMatchObject({ status: 'completed', claim: { token: 1 } });
      expect([...a.seen, ...b.seen].filter((event) => event.type === 'claimed')).toHaveLength(1);
      expect(spans([...a.observed, ...b.observed], 'deuz.goal.claim')).toHaveLength(1);
    } finally {
      await store.close();
    }
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'supervisor',
  'idle-run-cancel',
  async () => {
    // A cancel for an idle run (suspended on approval: nobody holds it, so its
    // lease signal is not delivered) and one that came before a goal's first
    // launch are recorded; the process dies; after the restart both are
    // applied at the next claim and neither run is launched or resumed.
    const file = await databaseFile();
    const time = manualClock(T0);
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    try {
      const before = createSqliteGoalRuntimeStore({ path: file.path, clock: time.clock });
      const first = fakeRunLauncher((request) => ({
        runId: request.runId,
        result: results.suspended(request.runId),
      }));
      const a = supervise(before, provider, time, { owner: 'sup-a', launcher: first });
      await a.supervisor.submit({ goalId: 'idle', scope: SCOPE, objective: 'x' });
      await a.supervisor.tick();
      expect((await a.supervisor.get(SCOPE, 'idle'))?.runtime.phase).toBe('idle');
      await a.supervisor.command(SCOPE, 'idle', { type: 'cancel', reason: 'not needed' });
      expect(first.cancels).toEqual([{ scope: SCOPE, runId: 'idle:run:1', reason: 'not needed' }]);
      await a.supervisor.submit({ goalId: 'early', scope: SCOPE, objective: 'y' });
      await a.supervisor.command(SCOPE, 'early', { type: 'cancel' });
      expect(first.calls).toHaveLength(1);
      await before.close();

      const after = createSqliteGoalRuntimeStore({ path: file.path, clock: time.clock });
      try {
        const second = fakeRunLauncher();
        const b = supervise(after, provider, time, { owner: 'sup-b', launcher: second });
        expect(await b.supervisor.tick()).toMatchObject({ cancelled: 2, dispatched: 0 });
        expect(second.calls).toEqual([]);
        for (const goalId of ['idle', 'early']) {
          const state = await b.supervisor.get(SCOPE, goalId);
          expect(state?.goal.status, goalId).toBe('cancelled');
          expect(state?.runtime.phase, goalId).toBe('done');
          expect(state?.runtime.cancel?.appliedAt, goalId).toBe(T0);
        }
        expect(await after.intents.get(SCOPE, 'early#1')).toMatchObject({ status: 'cancelled' });
        expect(spans(b.observed, 'deuz.goal.cancel_applied')).toHaveLength(2);
        expect(await b.supervisor.tick()).toEqual({
          applied: 0,
          dispatched: 0,
          cancelled: 0,
          skipped: 0,
        });
      } finally {
        await after.close();
      }
    } finally {
      await file.remove();
    }
  },
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'supervisor',
  'drain-to-checkpoint',
  async () => {
    // drain() stops taking work and brings the running run to its next safe
    // checkpoint; the run stays resumable and the next supervisor resumes it,
    // never starting it again.
    const time = manualClock(T0);
    const store = createSqliteGoalRuntimeStore({ path: ':memory:', clock: time.clock });
    try {
      const provider = createInMemoryLeaseProvider({ clock: time.clock });
      let first = true;
      const launcher = fakeRunLauncher((request) => {
        if (first) {
          first = false;
          return 'hold';
        }
        return { runId: request.runId, result: results.completed(request.runId) };
      });
      const a = supervise(store, provider, time, { owner: 'sup-a', launcher });
      await a.supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
      const ticking = a.supervisor.tick();
      await launcher.whenHeld();
      await a.supervisor.drain();
      await ticking;
      expect(launcher.drains).toEqual([{ scope: SCOPE, runId: 'g:run:1' }]);
      expect((await a.supervisor.get(SCOPE, 'g'))?.runtime.phase).toBe('dispatching');
      expect((await store.intents.get(SCOPE, 'g#1'))?.status).toBe('launched');
      expect(a.seen).toContainEqual({
        type: 'drained',
        scope: SCOPE,
        goalId: 'g',
        runId: 'g:run:1',
      });
      expect(spans(a.observed, 'deuz.goal.drain')).toHaveLength(1);
      // No new work after the drain: a goal submitted now is not started by this supervisor.
      await a.supervisor.submit({ goalId: 'h', scope: SCOPE, objective: 'y' });
      expect(await a.supervisor.tick()).toEqual({
        applied: 0,
        dispatched: 0,
        cancelled: 0,
        skipped: 0,
      });
      expect(launcher.calls.map((call) => call.request.goalId)).toEqual(['g']);
      const b = supervise(store, provider, time, { owner: 'sup-b', launcher });
      await b.supervisor.tick();
      expect(launcher.calls.filter((call) => call.request.goalId === 'g')).toMatchObject([
        { kind: 'launch', request: { runId: 'g:run:1' } },
        { kind: 'resume', request: { runId: 'g:run:1' } },
      ]);
      expect((await b.supervisor.get(SCOPE, 'g'))?.runtime.runs).toBe(1);
    } finally {
      await store.close();
    }
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'supervisor',
  'retry-with-stored-approvals',
  async () => {
    // A run waits for an approval; the host answers; the resumed leg fails
    // with an error the native layer marks retryable. The retry passes the
    // stored verdict again as approvalResponses, so the call is not gated
    // again (the 2.3 known limit of a plain resume).
    const time = manualClock(T0);
    const store = createSqliteGoalRuntimeStore({ path: ':memory:', clock: time.clock });
    try {
      const provider = createInMemoryLeaseProvider({ clock: time.clock });
      const launcher = fakeRunLauncher((request, kind) => {
        if (kind === 'launch')
          return { runId: request.runId, result: results.suspended(request.runId, ['ap-1']) };
        if (request.kind === 'resume')
          return {
            runId: request.runId,
            result: results.failed(request.runId, 'overloaded'),
            retryable: true,
          };
        return { runId: request.runId, result: results.completed(request.runId) };
      });
      const { supervisor } = supervise(store, provider, time, { owner: 'sup-a', launcher });
      await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'Deploy.' });
      await supervisor.tick();
      const verdicts = [{ approvalId: 'ap-1', approved: true, reason: 'ship it' }];
      await supervisor.resume(SCOPE, 'g', { approvalResponses: verdicts });
      await supervisor.tick();
      expect((await supervisor.get(SCOPE, 'g'))?.runtime).toMatchObject({
        phase: 'retrying',
        retryAt: T0 + 1_000,
      });
      await time.advance(1_000);
      await supervisor.tick();
      expect(
        launcher.calls.map((call) => [call.request.kind, call.request.approvalResponses]),
      ).toEqual([
        ['start', undefined],
        ['resume', verdicts],
        ['retry', verdicts],
      ]);
      expect(launcher.calls.every((call) => call.request.runId === 'g:run:1')).toBe(true);
      expect((await supervisor.get(SCOPE, 'g'))?.runtime).toMatchObject({ phase: 'idle' });
    } finally {
      await store.close();
    }
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'supervisor',
  'accounting-watermark-once',
  async () => {
    // A leg's ledger difference is charged with its watermark in one write;
    // the process dies before the leg is recorded; the next holder resumes
    // the run, reads the same durable ledger and charges nothing again.
    // Reservations are recorded, never charged, and a late charge on the
    // completed goal raises its spend without reopening it.
    const file = await databaseFile();
    const time = manualClock(T0);
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    try {
      const store = createSqliteGoalRuntimeStore({ path: file.path, clock: time.clock });
      let crash = true;
      const dying: GoalRuntimeStore = {
        ...store,
        intents: {
          ...store.intents,
          complete: async (...args) => {
            if (crash) throw new Error('process died before the leg was recorded');
            return store.intents.complete(...args);
          },
        },
      };
      const first = fakeRunLauncher((request) => ({
        runId: request.runId,
        result: results.completed(request.runId),
      }));
      first.ledger.set('g:run:1', totals({ tokens: 1_000, usd: 2 }, { tokens: 50, usd: 0.1 }));
      const a = supervise(dying, provider, time, { owner: 'sup-a', launcher: first });
      await a.supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
      await a.supervisor.tick();
      expect((await store.load('g'))?.spent).toEqual({ tokens: 1_000, usd: 2 });
      await store.close();
      crash = false;

      // The dead holder's lease runs out; another process opens the file.
      await time.advance(30_001);
      const reopened = createSqliteGoalRuntimeStore({ path: file.path, clock: time.clock });
      try {
        const second = fakeRunLauncher((request) => ({
          runId: request.runId,
          result: results.completed(request.runId),
          maintenance: 'pending',
        }));
        second.ledger.set('g:run:1', totals({ tokens: 1_000, usd: 2 }, { tokens: 50, usd: 0.1 }));
        second.upkeep.set('g:run:1', 'pending');
        const b = supervise(reopened, provider, time, {
          owner: 'sup-b',
          launcher: second,
          verify: ({ runId }): GoalCommand => ({
            type: 'evaluate',
            results: [
              { criterionId: 'objective', verdict: 'passed', source: 'test', evidence: ['e-1'] },
            ],
            evidence: [{ id: 'e-1', source: 'test', ref: 'report.xml', runId }],
          }),
        });
        await b.supervisor.tick();
        expect(second.calls.map((call) => call.request.runId)).toEqual(['g:run:1']);
        let goal = (await reopened.load('g'))!;
        expect(goal).toMatchObject({ status: 'completed', spent: { tokens: 1_000, usd: 2 } });
        expect(await reopened.watermarks.get(SCOPE, 'g', 'g:run:1')).toMatchObject({
          tokens: 1_000,
          reservedTokens: 50,
          revision: 1,
        });
        // The memory extraction's charge lands after the goal completed.
        second.ledger.set('g:run:1', totals({ tokens: 1_200, usd: 2.5 }));
        second.upkeep.set('g:run:1', 'complete');
        await b.supervisor.tick();
        goal = (await reopened.load('g'))!;
        expect(goal).toMatchObject({ status: 'completed', spent: { tokens: 1_200, usd: 2.5 } });
        expect(goal.charged).toHaveLength(2);
        expect((await b.supervisor.get(SCOPE, 'g'))?.runtime.maintenance).toEqual({
          status: 'complete',
          runId: 'g:run:1',
        });
        await b.supervisor.tick();
        expect((await reopened.load('g'))?.spent.tokens).toBe(1_200);
      } finally {
        await reopened.close();
      }
    } finally {
      await file.remove();
    }
  },
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'supervisor',
  'lease-loss-drains',
  async () => {
    // The supervisor loses the goal lease while its run works: it drains the
    // run, writes nothing more and starts nothing new; the next holder takes
    // the intent over with a higher token and continues the same run.
    const time = manualClock(T0);
    const store = createSqliteGoalRuntimeStore({ path: ':memory:', clock: time.clock });
    try {
      const real = createInMemoryLeaseProvider({ clock: time.clock });
      let lose = false;
      const flaky: LeaseProvider = {
        acquire: (request) => real.acquire(request),
        renew: async (lease, ttlMs, options) =>
          lose ? { held: false } : real.renew(lease, ttlMs, options),
        release: (lease) => real.release(lease),
        signal: (key, signal) => real.signal(key, signal),
      };
      let held = false;
      const launcher = fakeRunLauncher((request) => {
        if (!held) {
          held = true;
          return 'hold';
        }
        return { runId: request.runId, result: results.completed(request.runId) };
      });
      const a = supervise(store, flaky, time, { owner: 'sup-a', launcher });
      await a.supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
      const ticking = a.supervisor.tick();
      await launcher.whenHeld();
      const before = await a.supervisor.get(SCOPE, 'g');
      lose = true;
      await time.advance(10_000);
      await ticking;
      expect(a.seen).toContainEqual({ type: 'lease-lost', scope: SCOPE, goalId: 'g' });
      expect(launcher.drains).toEqual([{ scope: SCOPE, runId: 'g:run:1' }]);
      expect(spans(a.observed, 'deuz.goal.drain')).toHaveLength(1);
      expect(await a.supervisor.get(SCOPE, 'g')).toEqual(before);
      await a.supervisor.tick();
      expect(launcher.calls).toHaveLength(1);

      await time.advance(30_000);
      const b = supervise(store, real, time, { owner: 'sup-b', launcher });
      await b.supervisor.tick();
      expect(launcher.calls.map((call) => call.request.runId)).toEqual(['g:run:1', 'g:run:1']);
      expect(await store.intents.get(SCOPE, 'g#1')).toMatchObject({
        status: 'completed',
        claim: { owner: 'sup-b', token: 2 },
      });
      expect((await b.supervisor.get(SCOPE, 'g'))?.runtime.runs).toBe(1);
    } finally {
      await store.close();
    }
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);
