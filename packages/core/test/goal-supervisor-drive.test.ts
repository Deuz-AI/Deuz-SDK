/**
 * How the goal supervisor drives a goal (2.4, spec §3.1 and the §2.5
 * inheritance rule): the `goal:` lease and intent claims (one executor),
 * launches through the `RunLauncher` seam, leg outcomes, retries, cancel
 * application, drain, lease loss, watermark accounting and working memory,
 * on the real in-memory goal runtime store with a scripted launcher.
 */
import { describe, expect, it } from 'vitest';
import {
  createGoalSupervisor,
  createInMemoryGoalRuntimeStore,
  goalLeaseKey,
} from '../src/goal/runtime';
import type {
  GoalRuntimeStore,
  GoalSupervisorEvent,
  GoalSupervisorOptions,
} from '../src/goal/runtime';
import { createInMemoryLeaseProvider } from '../src/ops';
import type { LeaseProvider } from '../src/types/lease';
import type { ObserveEvent } from '../src/types/observe';
import { fakeRunLauncher, results } from './fixtures/fake-run-launcher';
import type { FakeRunLauncher } from './fixtures/fake-run-launcher';
import { manualClock } from './fixtures/manual-clock';

const T0 = Date.parse('2026-10-15T09:00:00Z');
const SCOPE = 'tenant-a';

interface World {
  time: ReturnType<typeof manualClock>;
  store: GoalRuntimeStore;
  provider: LeaseProvider;
  observed: ObserveEvent[];
}

function world(): World {
  const time = manualClock(T0);
  return {
    time,
    store: createInMemoryGoalRuntimeStore({ deps: { clock: time.clock } }),
    provider: createInMemoryLeaseProvider({ clock: time.clock }),
    observed: [],
  };
}

/** A supervisor in `w`, with its launcher and the events it emitted. */
function supervisorIn(
  w: World,
  options: Partial<GoalSupervisorOptions> & { owner?: string; launcher?: FakeRunLauncher } = {},
) {
  const { owner = 'sup-a', launcher = fakeRunLauncher(), ...rest } = options;
  const supervisor = createGoalSupervisor({
    store: w.store,
    launcher,
    lease: { provider: w.provider, owner },
    deps: { clock: w.time.clock, observer: { emit: (event) => void w.observed.push(event) } },
    ...rest,
  });
  const seen: GoalSupervisorEvent[] = [];
  const controller = new AbortController();
  void (async () => {
    for await (const event of supervisor.events({ signal: controller.signal })) seen.push(event);
  })();
  return { supervisor, launcher, seen, stop: () => controller.abort() };
}

const completedSpans = (observed: ObserveEvent[], name: string) =>
  observed.filter(
    (event) =>
      event.type === 'operation.completed' && 'operation' in event && event.operation === name,
  );

describe('claim and launch', () => {
  it('claims the goal lease, claims the intent with its token and launches the run', async () => {
    const w = world();
    const { supervisor, launcher, seen } = supervisorIn(w);
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'Ship it.' });
    expect(await supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 1,
      cancelled: 0,
      skipped: 0,
    });
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]).toMatchObject({
      kind: 'launch',
      request: {
        scope: SCOPE,
        goalId: 'g-1',
        intentId: 'g-1#1',
        runId: 'g-1:run:1',
        attempt: 1,
        kind: 'start',
        goal: { goalId: 'g-1', runId: 'g-1:run:1' },
      },
    });
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      status: 'completed',
      claim: { owner: 'sup-a', token: 1 },
      outcome: { status: 'completed' },
    });
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime).toMatchObject({
      phase: 'idle',
      runs: 1,
    });
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime.activeRun).toBeUndefined();
    expect(seen.map((event) => event.type)).toEqual(['claimed', 'dispatched', 'run-ended']);
    expect(seen[0]).toEqual({ type: 'claimed', scope: SCOPE, goalId: 'g-1', token: 1 });
    expect(seen[2]).toMatchObject({ runId: 'g-1:run:1', status: 'completed' });
    expect(completedSpans(w.observed, 'deuz.goal.claim')[0]).toMatchObject({
      attributes: { 'deuz.goal.id': 'g-1' },
    });
    expect(completedSpans(w.observed, 'deuz.goal.dispatch')[0]).toMatchObject({
      attributes: {
        'deuz.goal.id': 'g-1',
        'deuz.goal.run_id': 'g-1:run:1',
        'deuz.goal.attempt': 1,
      },
    });
    // The goal lease went back after the drive.
    const lease = await w.provider.acquire({
      key: goalLeaseKey(SCOPE, 'g-1'),
      owner: 'other',
      ttlMs: 1_000,
    });
    expect(lease?.token).toBe(2);
  });

  it('drives a goal with one executor: a second supervisor skips it while its lease is held', async () => {
    const w = world();
    const launcher = fakeRunLauncher(() => 'hold');
    const a = supervisorIn(w, { owner: 'sup-a', launcher });
    const b = supervisorIn(w, { owner: 'sup-b', launcher });
    await a.supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const ticking = a.supervisor.tick();
    const leg = await launcher.whenHeld();
    expect(await b.supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 0,
      cancelled: 0,
      skipped: 1,
    });
    expect((await a.supervisor.get(SCOPE, 'g-1'))?.runtime.phase).toBe('running');
    leg.finish({ runId: 'g-1:run:1', result: results.completed('g-1:run:1') });
    await ticking;
    expect(launcher.calls).toHaveLength(1);
  });

  it('starts nothing for a goal no one asked to start', async () => {
    const w = world();
    const { supervisor, launcher } = supervisorIn(w);
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', { type: 'wait', wait: { reason: 'user' } });
    expect(await supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 0,
      cancelled: 0,
      skipped: 0,
    });
    expect(launcher.calls).toEqual([]);
  });
});
