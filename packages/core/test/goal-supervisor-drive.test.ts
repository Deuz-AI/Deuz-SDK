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
import type { GoalCommand } from '../src/goal';
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

/** The evaluate command a host verifier answers for a passed run. */
function passed(runId: string): GoalCommand {
  return {
    type: 'evaluate',
    results: [{ criterionId: 'objective', verdict: 'passed', source: 'test', evidence: ['e-1'] }],
    evidence: [{ id: 'e-1', source: 'test', ref: 'report.xml', runId }],
  };
}

describe('leg outcomes', () => {
  it('applies the host verification of a completed run, then completes the goal', async () => {
    const w = world();
    const { supervisor } = supervisorIn(w, { verify: ({ runId }) => passed(runId) });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    const after = await supervisor.get(SCOPE, 'g-1');
    expect(after?.goal).toMatchObject({ status: 'completed', outcome: { reason: 'accepted' } });
    expect(after?.runtime).toMatchObject({ phase: 'done' });
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({ status: 'completed' });
    expect(await supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 0,
      cancelled: 0,
      skipped: 0,
    });
  });

  it('starts another automatic run while the goal stays active, within maxRuns', async () => {
    const w = world();
    const { supervisor, launcher, seen } = supervisorIn(w, { policy: { maxRuns: 2 } });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    await supervisor.tick();
    expect(launcher.calls.map((call) => [call.kind, call.request.runId])).toEqual([
      ['launch', 'g-1:run:1'],
      ['launch', 'g-1:run:2'],
    ]);
    const second = launcher.calls[1]!.request;
    expect(second.goal.runId).toBe('g-1:run:2');
    expect(await w.store.intents.get(SCOPE, second.intentId)).toMatchObject({
      kind: 'start',
      cause: { command: 'auto' },
    });
    await supervisor.tick();
    await supervisor.tick();
    expect(launcher.calls).toHaveLength(2);
    expect(seen.filter((event) => event.type === 'policy-limit')).toEqual([
      { type: 'policy-limit', scope: SCOPE, goalId: 'g-1', limit: 'runs' },
    ]);
    // Only the host raises a limit, at the runtime revision it read.
    const { runtime } = (await supervisor.get(SCOPE, 'g-1'))!;
    await supervisor.updatePolicy(
      SCOPE,
      'g-1',
      { maxRuns: 3 },
      { expectedRevision: runtime.revision },
    );
    await supervisor.tick();
    expect(launcher.calls.map((call) => call.request.runId)).toContain('g-1:run:3');
  });

  it('parks a suspended run until the host resumes it with its verdicts and client results', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request, kind) =>
      kind === 'launch'
        ? { runId: request.runId, result: results.suspended(request.runId) }
        : { runId: request.runId, result: results.completed(request.runId) },
    );
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    const parked = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(parked.goal).toMatchObject({
      status: 'waiting',
      waiting: { reason: 'user', note: 'approval' },
    });
    expect(parked.runtime).toMatchObject({ phase: 'idle', activeRun: { runId: 'g-1:run:1' } });
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      status: 'completed',
      outcome: { status: 'suspended' },
    });
    await supervisor.tick();
    expect(launcher.calls).toHaveLength(1);
    const approvalResponses = [{ approvalId: 'ap-1', approved: true }];
    const clientToolResults = [{ toolCallId: 'c-1', output: { ok: true } }];
    await supervisor.resume(SCOPE, 'g-1', { approvalResponses, clientToolResults });
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.status).toBe('active');
    await expect(supervisor.resume(SCOPE, 'g-1', {})).rejects.toMatchObject({
      code: 'invalid_command',
    });
    await supervisor.tick();
    expect(launcher.calls[1]).toMatchObject({
      kind: 'resume',
      request: { kind: 'resume', runId: 'g-1:run:1', approvalResponses, clientToolResults },
    });
  });

  it('hands a run that stopped or failed for good to the host instead of starting another', async () => {
    for (const [result, note, status] of [
      [results.stopped('g-1:run:1', 'max-steps'), 'run-stopped:max-steps', 'completed'],
      [results.failed('g-1:run:1', 'invalid_output'), 'run-failed:invalid_output', 'failed'],
    ] as const) {
      const w = world();
      const launcher = fakeRunLauncher((request) => ({ runId: request.runId, result }));
      const { supervisor } = supervisorIn(w, { launcher });
      await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
      await supervisor.tick();
      await supervisor.tick();
      expect(launcher.calls).toHaveLength(1);
      const after = (await supervisor.get(SCOPE, 'g-1'))!;
      expect(after.goal).toMatchObject({ status: 'waiting', waiting: { reason: 'user', note } });
      expect(after.runtime.phase).toBe('idle');
      expect(after.runtime.activeRun).toBeUndefined();
      expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe(status);
    }
  });
});

describe('retries', () => {
  it('retries a retryable failure after 1 s, 5 s and 30 s, then parks until the limit is raised', async () => {
    const w = world();
    let failures = 4;
    const launcher = fakeRunLauncher((request) => {
      failures -= 1;
      return failures >= 0
        ? {
            runId: request.runId,
            result: results.failed(request.runId, 'overloaded'),
            retryable: true,
          }
        : { runId: request.runId, result: results.completed(request.runId) };
    });
    const { supervisor, seen } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime).toMatchObject({
      phase: 'retrying',
      retries: 0,
      retryAt: T0 + 1_000,
    });
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      status: 'failed',
      outcome: { status: 'failed', error: { code: 'overloaded' } },
    });
    await supervisor.tick();
    expect(launcher.calls).toHaveLength(1);
    for (const wait of [1_000, 5_000, 30_000]) {
      await w.time.advance(wait);
      await supervisor.tick();
    }
    expect(
      launcher.calls.map((call) => [
        call.kind,
        call.request.kind,
        call.request.runId,
        call.request.attempt,
      ]),
    ).toEqual([
      ['launch', 'start', 'g-1:run:1', 1],
      ['resume', 'retry', 'g-1:run:1', 2],
      ['resume', 'retry', 'g-1:run:1', 3],
      ['resume', 'retry', 'g-1:run:1', 4],
    ]);
    expect(seen.filter((event) => event.type === 'retry-scheduled')).toEqual([
      { type: 'retry-scheduled', scope: SCOPE, goalId: 'g-1', attempt: 2, at: T0 + 1_000 },
      { type: 'retry-scheduled', scope: SCOPE, goalId: 'g-1', attempt: 3, at: T0 + 6_000 },
      { type: 'retry-scheduled', scope: SCOPE, goalId: 'g-1', attempt: 4, at: T0 + 36_000 },
    ]);
    expect(completedSpans(w.observed, 'deuz.goal.retry')).toHaveLength(3);
    expect(seen.filter((event) => event.type === 'policy-limit')).toEqual([
      { type: 'policy-limit', scope: SCOPE, goalId: 'g-1', limit: 'retries' },
    ]);
    await w.time.advance(60_000);
    await supervisor.tick();
    expect(launcher.calls).toHaveLength(4);
    const { runtime } = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(runtime).toMatchObject({ phase: 'retrying', retries: 3 });
    await supervisor.updatePolicy(
      SCOPE,
      'g-1',
      { maxRetries: 4 },
      { expectedRevision: runtime.revision },
    );
    await supervisor.tick();
    expect(launcher.calls).toHaveLength(5);
    expect(launcher.calls[4]?.request).toMatchObject({ kind: 'retry', attempt: 5 });
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime).toMatchObject({
      phase: 'idle',
      retries: 4,
    });
  });

  it('treats a launch that threw as retryable: the same run is resumed, never started again', async () => {
    const w = world();
    let thrown = false;
    const launcher = fakeRunLauncher((request) => {
      if (!thrown) {
        thrown = true;
        throw Object.assign(new Error('store unavailable'), { code: 'ECONNRESET' });
      }
      return { runId: request.runId, result: results.completed(request.runId) };
    });
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      status: 'failed',
      outcome: { status: 'failed', error: { name: 'Error', code: 'ECONNRESET' } },
    });
    await w.time.advance(1_000);
    await supervisor.tick();
    expect(launcher.calls.map((call) => [call.kind, call.request.runId])).toEqual([
      ['launch', 'g-1:run:1'],
      ['resume', 'g-1:run:1'],
    ]);
  });
});

describe('cancel application', () => {
  it('applies a cancel recorded for an idle run at the next claim, and never resumes the run', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request) => ({
      runId: request.runId,
      result: results.suspended(request.runId),
    }));
    const { supervisor, seen } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    await supervisor.command(SCOPE, 'g-1', { type: 'cancel', reason: 'scope cut' });
    // Nobody holds the idle run: the signal is not delivered, the record stays.
    expect(launcher.cancels).toEqual([{ scope: SCOPE, runId: 'g-1:run:1', reason: 'scope cut' }]);
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.status).toBe('waiting');
    expect(await supervisor.tick()).toMatchObject({ cancelled: 1, dispatched: 0 });
    const after = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(after.goal).toMatchObject({
      status: 'cancelled',
      outcome: { reason: 'cancelled', detail: 'scope cut' },
    });
    expect(after.runtime).toMatchObject({
      phase: 'done',
      cancel: { requestedAt: T0, reason: 'scope cut', appliedAt: T0 },
    });
    expect(after.runtime.activeRun).toBeUndefined();
    expect(launcher.calls).toHaveLength(1);
    expect(seen.filter((event) => event.type.startsWith('cancel'))).toEqual([
      { type: 'cancel-requested', scope: SCOPE, goalId: 'g-1' },
      { type: 'cancel-applied', scope: SCOPE, goalId: 'g-1', runId: 'g-1:run:1' },
    ]);
    expect(completedSpans(w.observed, 'deuz.goal.cancel_applied')).toHaveLength(1);
    expect(await supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 0,
      cancelled: 0,
      skipped: 0,
    });
  });

  it('applies a cancel that came before the first launch at the claim, without launching', async () => {
    const w = world();
    const { supervisor, launcher } = supervisorIn(w);
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.command(SCOPE, 'g-1', { type: 'cancel' });
    expect(await supervisor.tick()).toMatchObject({ cancelled: 1, dispatched: 0 });
    expect(launcher.calls).toEqual([]);
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      status: 'cancelled',
      claim: { owner: 'sup-a', token: 1 },
    });
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.status).toBe('cancelled');
  });

  it('applies a cancel sent during a leg once the run stops', async () => {
    const w = world();
    const launcher = fakeRunLauncher(() => 'hold');
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const ticking = supervisor.tick();
    await launcher.whenHeld();
    await supervisor.command(SCOPE, 'g-1', { type: 'cancel' });
    expect(await ticking).toMatchObject({ dispatched: 1, cancelled: 1 });
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      status: 'cancelled',
      outcome: { status: 'stopped', reason: 'cancelled' },
    });
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.status).toBe('cancelled');
  });
});

describe('drain and lease loss', () => {
  it('drains: no new work, the running run stops at a safe checkpoint, the next holder resumes it', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request, kind) =>
      kind === 'launch'
        ? 'hold'
        : { runId: request.runId, result: results.completed(request.runId) },
    );
    const a = supervisorIn(w, { owner: 'sup-a', launcher });
    await a.supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const ticking = a.supervisor.tick();
    await launcher.whenHeld();
    await a.supervisor.drain();
    await ticking;
    expect(launcher.drains).toEqual([{ scope: SCOPE, runId: 'g-1:run:1' }]);
    expect((await a.supervisor.get(SCOPE, 'g-1'))?.runtime).toMatchObject({
      phase: 'dispatching',
      activeRun: { runId: 'g-1:run:1' },
    });
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('launched');
    expect(a.seen.some((event) => event.type === 'drained')).toBe(true);
    expect(completedSpans(w.observed, 'deuz.goal.drain')).toHaveLength(1);
    expect(await a.supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 0,
      cancelled: 0,
      skipped: 0,
    });
    const b = supervisorIn(w, { owner: 'sup-b', launcher });
    await b.supervisor.tick();
    expect(launcher.calls.map((call) => [call.kind, call.request.runId])).toEqual([
      ['launch', 'g-1:run:1'],
      ['resume', 'g-1:run:1'],
    ]);
  });

  it('drains the running run when the goal lease is lost, and writes nothing more', async () => {
    const w = world();
    const real = w.provider;
    let lose = false;
    const flaky: LeaseProvider = {
      acquire: (request) => real.acquire(request),
      renew: async (lease, ttlMs, options) =>
        lose ? { held: false } : real.renew(lease, ttlMs, options),
      release: (lease) => real.release(lease),
      signal: (key, signal) => real.signal(key, signal),
    };
    let first = true;
    const launcher = fakeRunLauncher((request) => {
      if (first) {
        first = false;
        return 'hold';
      }
      return { runId: request.runId, result: results.completed(request.runId) };
    });
    const a = supervisorIn({ ...w, provider: flaky }, { owner: 'sup-a', launcher });
    await a.supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const ticking = a.supervisor.tick();
    await launcher.whenHeld();
    const before = (await a.supervisor.get(SCOPE, 'g-1'))!;
    lose = true;
    await w.time.advance(10_000);
    await ticking;
    expect(launcher.drains).toEqual([{ scope: SCOPE, runId: 'g-1:run:1' }]);
    expect(a.seen.some((event) => event.type === 'lease-lost')).toBe(true);
    // Nothing written after the loss, and no new run.
    expect(await a.supervisor.get(SCOPE, 'g-1')).toEqual(before);
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.claim?.token).toBe(1);
    expect(launcher.calls).toHaveLength(1);
    // The next holder takes the intent over with a higher token: the same run, no new one.
    await w.time.advance(30_000);
    const b = supervisorIn(w, { owner: 'sup-b', launcher });
    await b.supervisor.tick();
    expect(launcher.calls.map((call) => call.request.runId)).toEqual(['g-1:run:1', 'g-1:run:1']);
    expect(await w.store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      status: 'completed',
      claim: { owner: 'sup-b', token: 2 },
    });
    expect((await b.supervisor.get(SCOPE, 'g-1'))?.runtime.runs).toBe(1);
  });
});
