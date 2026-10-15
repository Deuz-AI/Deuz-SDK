/**
 * How the goal supervisor drives a goal (2.4, spec §3.1 and the §2.5
 * inheritance rule): the `goal:` lease and intent claims (one executor),
 * launches through the `RunLauncher` seam, leg outcomes, retries, cancel
 * application, drain, lease loss, watermark accounting and working memory,
 * on the real in-memory goal runtime store with a scripted launcher.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGoalEvent } from '../src/goal';
import {
  createGoalSupervisor,
  createInMemoryGoalRuntimeStore,
  goalDeliveryDigest,
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
import { fakeRunLauncher, results, totals } from './fixtures/fake-run-launcher';
import type { FakeRunLauncher } from './fixtures/fake-run-launcher';
import { manualClock } from './fixtures/manual-clock';
import { createWorkingMemoryFixture } from './fixtures/working-memory';

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

  it('parks a goal whose verifier throws or answers a malformed command', async () => {
    for (const verify of [
      () => {
        throw new Error('verifier down');
      },
      () => ({ type: 'evaluate', results: 'nope' }) as unknown as GoalCommand,
    ]) {
      const w = world();
      const { supervisor, launcher } = supervisorIn(w, { verify });
      await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
      await supervisor.tick();
      await supervisor.tick();
      expect(launcher.calls).toHaveLength(1);
      expect((await supervisor.get(SCOPE, 'g-1'))?.goal).toMatchObject({
        status: 'waiting',
        waiting: { reason: 'user', note: 'verify-failed' },
      });
      expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('completed');
    }
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

  it('keeps the intent and the run while another executor holds it, and resumes it at a later claim', async () => {
    const w = world();
    let elsewhere = true;
    const launcher = fakeRunLauncher((request) =>
      elsewhere
        ? {
            runId: request.runId,
            result: results.failed(request.runId, 'lease_held'),
            heldElsewhere: true,
          }
        : { runId: request.runId, result: results.completed(request.runId) },
    );
    const { supervisor, seen } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    await supervisor.tick();
    expect(await supervisor.get(SCOPE, 'g-1')).toMatchObject({
      goal: { status: 'active' },
      runtime: {
        phase: 'dispatching',
        activeRun: { intentId: 'g-1#1', runId: 'g-1:run:1', attempt: 1 },
        runs: 1,
        retries: 0,
      },
    });
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('claimed');
    expect(seen.filter((event) => event.type === 'retry-scheduled')).toEqual([]);
    elsewhere = false;
    await supervisor.tick();
    expect(launcher.calls.map((call) => [call.request.intentId, call.request.runId])).toEqual([
      ['g-1#1', 'g-1:run:1'],
      ['g-1#1', 'g-1:run:1'],
      ['g-1#1', 'g-1:run:1'],
    ]);
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('completed');
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime).toMatchObject({
      phase: 'idle',
      runs: 1,
      retries: 0,
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

describe('accounting', () => {
  it('charges the run ledger above its watermark once, keeping reservations apart', async () => {
    const w = world();
    let legs = 0;
    const launcher = fakeRunLauncher((request) => {
      legs += 1;
      return legs === 1
        ? { runId: request.runId, result: results.suspended(request.runId) }
        : { runId: request.runId, result: results.completed(request.runId) };
    });
    launcher.ledger.set('g-1:run:1', totals({ tokens: 100, usd: 0.5 }, { tokens: 20, usd: 0.1 }));
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.spent).toEqual({ tokens: 100, usd: 0.5 });
    expect(await w.store.watermarks.get(SCOPE, 'g-1', 'g-1:run:1')).toMatchObject({
      tokens: 100,
      usd: 0.5,
      reservedTokens: 20,
      reservedUsd: 0.1,
      revision: 1,
    });
    // The resumed leg settled the reservation: only the difference is charged.
    launcher.ledger.set('g-1:run:1', totals({ tokens: 130, usd: 0.6 }));
    await supervisor.resume(SCOPE, 'g-1', {
      approvalResponses: [{ approvalId: 'ap-1', approved: true }],
    });
    await supervisor.tick();
    const goal = (await supervisor.get(SCOPE, 'g-1'))!.goal;
    expect(goal.spent.tokens).toBe(130);
    expect(goal.spent.usd).toBeCloseTo(0.6, 10);
    expect(goal.charged).toEqual(['ledger:["g-1:run:1",1]', 'ledger:["g-1:run:1",2]']);
    expect(await w.store.watermarks.get(SCOPE, 'g-1', 'g-1:run:1')).toMatchObject({
      tokens: 130,
      reservedTokens: 0,
      revision: 2,
    });
  });

  it('charges the result accounting through the same watermark when the launcher reads no ledger', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request) => ({
      runId: request.runId,
      result: { ...results.suspended(request.runId), accounting: totals({ tokens: 7, usd: 0 }) },
    }));
    delete (launcher as Partial<FakeRunLauncher>).accounting;
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    await supervisor.resume(SCOPE, 'g-1', {});
    await supervisor.tick();
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.spent).toEqual({ tokens: 7, usd: 0 });
    expect(await w.store.watermarks.get(SCOPE, 'g-1', 'g-1:run:1')).toMatchObject({
      tokens: 7,
      revision: 1,
    });
  });

  it('completes a verified goal while its maintenance is pending, then adds a late charge without reopening it', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request) => ({
      runId: request.runId,
      result: results.completed(request.runId),
      maintenance: 'pending',
    }));
    launcher.ledger.set('g-1:run:1', totals({ tokens: 100, usd: 1 }));
    launcher.upkeep.set('g-1:run:1', 'pending');
    const { supervisor } = supervisorIn(w, { launcher, verify: ({ runId }) => passed(runId) });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    let after = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(after.goal).toMatchObject({ status: 'completed', spent: { tokens: 100, usd: 1 } });
    expect(after.runtime).toMatchObject({
      phase: 'done',
      maintenance: { status: 'pending', runId: 'g-1:run:1' },
    });
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('launched');
    // The memory extraction charged more afterwards.
    launcher.ledger.set('g-1:run:1', totals({ tokens: 140, usd: 1.25 }));
    await supervisor.tick();
    after = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(after.goal).toMatchObject({ status: 'completed', spent: { tokens: 140, usd: 1.25 } });
    expect(after.runtime.maintenance?.status).toBe('pending');
    launcher.upkeep.set('g-1:run:1', 'complete');
    await supervisor.tick();
    after = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(after.runtime.maintenance).toEqual({ status: 'complete', runId: 'g-1:run:1' });
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('completed');
    expect(after.goal.status).toBe('completed');
    expect(launcher.calls).toHaveLength(1);
    expect(await supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 0,
      cancelled: 0,
      skipped: 0,
    });
  });

  it('follows the pending maintenance of a run whose goal stayed active, after a later run completed it', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request) => ({
      runId: request.runId,
      result: results.completed(request.runId),
      maintenance: request.runId === 'g-1:run:1' ? 'pending' : 'complete',
    }));
    launcher.ledger.set('g-1:run:1', totals({ tokens: 100, usd: 0 }));
    launcher.upkeep.set('g-1:run:1', 'pending');
    const { supervisor } = supervisorIn(w, {
      launcher,
      verify: ({ runId }) => (runId === 'g-1:run:2' ? passed(runId) : undefined),
    });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    let after = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(after.goal).toMatchObject({ status: 'active', spent: { tokens: 100 } });
    expect(after.runtime.maintenance).toEqual({ status: 'pending', runId: 'g-1:run:1' });
    expect(after.runtime.maintenanceRuns).toEqual(['g-1:run:1']);
    // Its intent stays open while its maintenance is followed.
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('launched');
    // Run 1's extraction charges more while run 2 completes the goal; run
    // 2's settled maintenance does not hide run 1's pending one.
    launcher.ledger.set('g-1:run:1', totals({ tokens: 300, usd: 0 }));
    await supervisor.tick();
    after = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(launcher.calls.map((call) => call.request.runId)).toEqual(['g-1:run:1', 'g-1:run:2']);
    expect(after.goal).toMatchObject({ status: 'completed', spent: { tokens: 300 } });
    expect(after.runtime.maintenance).toEqual({ status: 'pending', runId: 'g-1:run:1' });
    launcher.ledger.set('g-1:run:1', totals({ tokens: 350, usd: 0 }));
    launcher.upkeep.set('g-1:run:1', 'complete');
    await supervisor.tick();
    after = (await supervisor.get(SCOPE, 'g-1'))!;
    expect(after.goal).toMatchObject({ status: 'completed', spent: { tokens: 350 } });
    expect(after.runtime.maintenance).toEqual({ status: 'complete', runId: 'g-1:run:1' });
    expect(after.runtime.maintenanceRuns).toBeUndefined();
    expect((await w.store.intents.get(SCOPE, 'g-1#1'))?.status).toBe('completed');
    expect(await supervisor.tick()).toEqual({
      applied: 0,
      dispatched: 0,
      cancelled: 0,
      skipped: 0,
    });
  });
});

describe('working memory', () => {
  const snapshot = (scope = SCOPE) => createWorkingMemoryFixture({ scope });

  it('hands the last snapshot to the next run of the same scope and spec generation, as it is', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request) => ({
      runId: request.runId,
      result: results.completed(request.runId),
      workingMemory: snapshot(),
    }));
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    const kept = (await supervisor.get(SCOPE, 'g-1'))!.runtime.workingMemory;
    expect(kept).toEqual({ ...snapshot(), goalRef: { goalId: 'g-1', specGeneration: 1 } });
    await supervisor.tick();
    expect(launcher.calls[0]?.request.workingMemory).toBeUndefined();
    const inherited = launcher.calls[1]?.request.workingMemory;
    expect(inherited).toEqual(kept);
    expect(inherited?.hypotheses.map((item) => item.status)).toEqual(
      snapshot().hypotheses.map((item) => item.status),
    );
  });

  it('hands nothing over after the spec generation changed, or from another scope', async () => {
    const w = world();
    let scope = SCOPE;
    const launcher = fakeRunLauncher((request) => ({
      runId: request.runId,
      result: results.completed(request.runId),
      workingMemory: snapshot(scope),
    }));
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    await supervisor.command(SCOPE, 'g-1', { type: 'revise', objective: 'y' });
    await supervisor.tick();
    expect(launcher.calls[1]?.request.goal.specGeneration).toBe(2);
    expect(launcher.calls[1]?.request.workingMemory).toBeUndefined();
    scope = 'tenant-b';
    await supervisor.tick();
    await supervisor.tick();
    expect(launcher.calls[3]?.request.workingMemory).toBeUndefined();
  });

  it('keeps the generation a run started under when the goal is revised before its resume or retry', async () => {
    for (const first of ['suspended', 'retryable'] as const) {
      const w = world();
      const launcher = fakeRunLauncher((request, kind) => {
        const result =
          kind === 'launch' && request.runId === 'g-1:run:1'
            ? first === 'suspended'
              ? results.suspended(request.runId)
              : results.failed(request.runId)
            : results.completed(request.runId);
        return {
          runId: request.runId,
          result,
          ...(result.status === 'failed' ? { retryable: true } : {}),
          workingMemory: snapshot(),
        };
      });
      const { supervisor } = supervisorIn(w, { launcher });
      await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
      await supervisor.tick();
      await supervisor.command(SCOPE, 'g-1', { type: 'revise', objective: 'y' });
      expect((await supervisor.get(SCOPE, 'g-1'))?.goal.specGeneration).toBe(2);
      if (first === 'suspended')
        await supervisor.resume(SCOPE, 'g-1', {
          approvalResponses: [{ approvalId: 'ap-1', approved: true }],
        });
      else await w.time.advance(1_000);
      // The resume or retry leg of run 1, which started under generation 1.
      await supervisor.tick();
      expect(launcher.calls[1]?.request).toMatchObject({
        runId: 'g-1:run:1',
        goal: { specGeneration: 2 },
      });
      expect((await supervisor.get(SCOPE, 'g-1'))?.runtime.workingMemory?.goalRef).toEqual({
        goalId: 'g-1',
        specGeneration: 1,
      });
      // The next run, under generation 2, inherits nothing from run 1.
      await supervisor.tick();
      expect(launcher.calls[2]?.request).toMatchObject({
        runId: 'g-1:run:2',
        goal: { specGeneration: 2 },
      });
      expect(launcher.calls[2]?.request.workingMemory).toBeUndefined();
    }
  });
});

describe('inbox, dependencies and time', () => {
  it('settles a due inbox entry and records the run it starts in the same write', async () => {
    const w = world();
    const { supervisor, launcher, seen } = supervisorIn(w);
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', {
      type: 'wait',
      wait: { reason: 'event', source: { type: 'signal', id: 'ci' } },
    });
    const goal = (await supervisor.get(SCOPE, 'g-1'))!.goal;
    const apply = vi.spyOn(w.store.inbox, 'apply');
    const early = createGoalEvent({
      scope: SCOPE,
      goalId: 'g-1',
      source: { type: 'signal', id: 'ci' },
      key: 'later',
      at: T0,
      notBefore: T0 + 60_000,
    });
    await supervisor.dispatch(early);
    const { entry } = await supervisor.dispatch(
      createGoalEvent({
        scope: SCOPE,
        goalId: 'g-1',
        source: { type: 'signal', id: 'ci' },
        key: 'build-1',
        at: T0,
        correlationId: goal.waiting!.id,
      }),
    );
    expect(await supervisor.tick()).toMatchObject({ applied: 1, dispatched: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
    const settled = await w.store.inbox.get(SCOPE, entry.id);
    expect(settled).toMatchObject({ disposition: 'applied' });
    expect(settled?.intentId).toBeDefined();
    expect(await w.store.intents.get(SCOPE, settled!.intentId!)).toMatchObject({
      kind: 'start',
      cause: { inboxEntryId: entry.id },
      status: 'completed',
    });
    expect(launcher.calls[0]?.request.goal.runId).toBe('g-1:run:1');
    expect(seen).toContainEqual({
      type: 'inbox-applied',
      scope: SCOPE,
      goalId: 'g-1',
      entryId: entry.id,
      disposition: 'applied',
    });
    // The early event stays pending, as it was queued.
    expect((await w.store.inbox.list({ scope: SCOPE, goalId: 'g-1' })).entries).toMatchObject([
      { deliveryId: 'later', disposition: 'pending' },
    ]);
  });

  it('records why an event did not apply', async () => {
    const w = world();
    const { supervisor } = supervisorIn(w);
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', { type: 'wait', wait: { reason: 'user' } });
    const { entry } = await supervisor.dispatch(
      createGoalEvent({
        scope: SCOPE,
        goalId: 'g-1',
        source: { type: 'schedule' },
        key: 'tick-1',
        at: T0,
      }),
    );
    expect(await supervisor.tick()).toMatchObject({ applied: 1, dispatched: 0 });
    expect((await w.store.inbox.get(SCOPE, entry.id))?.disposition).toBe('unmatched');
  });

  it('settles entries queued for a goal that already ended as terminal, so their payloads age out', async () => {
    for (const scopes of [undefined, [SCOPE]]) {
      const w = world();
      const { supervisor, seen } = supervisorIn(w, scopes ? { scopes } : {});
      await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
      await supervisor.command(SCOPE, 'g-1', { type: 'cancel' });
      await supervisor.tick();
      expect((await supervisor.get(SCOPE, 'g-1'))?.goal.status).toBe('cancelled');
      const event = (key: string, notBefore?: number) =>
        createGoalEvent({
          scope: SCOPE,
          goalId: 'g-1',
          source: { type: 'signal', id: 'hook' },
          key,
          at: w.time.clock.now(),
          ...(notBefore !== undefined ? { notBefore } : {}),
        });
      // Straight into the store, as the webhook handler and the scheduler queue theirs.
      const body = { body: '{"secret":"x"}' };
      const queued = await w.store.inbox.enqueue({
        scope: SCOPE,
        goalId: 'g-1',
        namespace: 'webhook:hook',
        deliveryId: 'delivery-1',
        event: event('delivery-1'),
        payload: body,
        digest: await goalDeliveryDigest({
          scope: SCOPE,
          goalId: 'g-1',
          event: event('delivery-1'),
          payload: body,
        }),
      });
      expect(queued.status).toBe('enqueued');
      // An early one too: an ended goal takes no event, early or not.
      await supervisor.dispatch(event('later', w.time.clock.now() + 3_600_000));
      expect(await supervisor.tick()).toMatchObject({ applied: 2, dispatched: 0 });
      expect((await w.store.inbox.list({ scope: SCOPE, goalId: 'g-1' })).entries).toEqual([]);
      const settled = await w.store.inbox.list({
        scope: SCOPE,
        goalId: 'g-1',
        dispositions: ['terminal'],
      });
      expect(settled.entries.map((entry) => entry.deliveryId).sort()).toEqual([
        'delivery-1',
        'later',
      ]);
      expect(seen).toContainEqual({
        type: 'inbox-applied',
        scope: SCOPE,
        goalId: 'g-1',
        entryId: queued.entry.id,
        disposition: 'terminal',
      });
      expect(await supervisor.get(SCOPE, 'g-1')).toMatchObject({
        goal: { status: 'cancelled' },
        runtime: { phase: 'done' },
      });
      await w.time.advance(8 * 24 * 60 * 60 * 1_000);
      expect(
        await w.store.prunePayloads({ before: w.time.clock.now() - 7 * 24 * 60 * 60 * 1_000 }),
      ).toBe(1);
      expect((await w.store.inbox.get(SCOPE, queued.entry.id))?.payloadPruned).toBe(true);
    }
  });

  it('reconciles a dependency wait with dependencies that already finished', async () => {
    const w = world();
    const { supervisor, launcher, seen } = supervisorIn(w);
    await supervisor.submit({ goalId: 'dep', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'dep', { type: 'wait', wait: { reason: 'user' } });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'y', start: false });
    await supervisor.command(SCOPE, 'g-1', {
      type: 'wait',
      wait: { reason: 'dependency', on: [{ kind: 'goal', id: 'dep' }] },
    });
    // Nothing finished yet: the waiting goal is not even claimed.
    await supervisor.tick();
    expect(seen.filter((event) => event.type === 'claimed')).toEqual([]);
    await supervisor.command(SCOPE, 'dep', { type: 'fail', reason: 'done elsewhere' });
    expect(await supervisor.tick()).toMatchObject({ applied: 1, dispatched: 1 });
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.status).toBe('active');
    expect(launcher.calls[0]?.request.goalId).toBe('g-1');
  });

  it('wakes a goal at its wakeup and fails one at its deadline', async () => {
    const w = world();
    const { supervisor, launcher } = supervisorIn(w);
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', {
      type: 'wait',
      wait: { reason: 'wakeup', at: T0 + 5_000 },
    });
    await supervisor.submit({
      goalId: 'g-2',
      scope: SCOPE,
      objective: 'y',
      start: false,
      deadline: T0 + 5_000,
    });
    await supervisor.command(SCOPE, 'g-2', { type: 'wait', wait: { reason: 'user' } });
    await supervisor.tick();
    expect(launcher.calls).toEqual([]);
    await w.time.advance(5_000);
    await supervisor.tick();
    expect(launcher.calls.map((call) => call.request.goalId)).toEqual(['g-1']);
    expect(await supervisor.get(SCOPE, 'g-2')).toMatchObject({
      goal: { status: 'failed', outcome: { reason: 'deadline' } },
      runtime: { phase: 'done' },
    });
  });

  it('only drives the scopes it was given', async () => {
    const w = world();
    const { supervisor, launcher } = supervisorIn(w, { scopes: ['tenant-b'] });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.submit({ goalId: 'g-2', scope: 'tenant-b', objective: 'y' });
    await supervisor.tick();
    expect(launcher.calls.map((call) => call.request.goalId)).toEqual(['g-2']);
  });
});

describe('start', () => {
  it('ticks every pollMs on the injected clock until stopped', async () => {
    const w = world();
    const { supervisor, launcher } = supervisorIn(w, { policy: { maxRuns: 3 } });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const loop = supervisor.start();
    expect(() => supervisor.start()).toThrow();
    await w.time.advance(0);
    expect(launcher.calls).toHaveLength(1);
    await w.time.advance(1_000);
    expect(launcher.calls).toHaveLength(2);
    await loop.stop();
    await w.time.advance(5_000);
    expect(launcher.calls).toHaveLength(2);
  });
});

describe('edge cases', () => {
  it('runs nothing for a waiting goal: a recorded start waits until the goal is active again', async () => {
    const w = world();
    const { supervisor, launcher } = supervisorIn(w);
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.command(SCOPE, 'g-1', { type: 'wait', wait: { reason: 'user' } });
    expect(await supervisor.tick()).toMatchObject({ dispatched: 0, skipped: 0 });
    expect(launcher.calls).toEqual([]);
    await supervisor.command(SCOPE, 'g-1', { type: 'resume' });
    await supervisor.tick();
    expect(launcher.calls.map((call) => call.request.intentId)).toEqual(['g-1#1']);
  });

  it('schedules no retry while the goal waits for budget', async () => {
    const w = world();
    let failed = false;
    const launcher = fakeRunLauncher((request) => {
      if (!failed) {
        failed = true;
        return {
          runId: request.runId,
          result: results.failed(request.runId, 'overloaded'),
          retryable: true,
        };
      }
      return { runId: request.runId, result: results.completed(request.runId) };
    });
    launcher.ledger.set('g-1:run:1', totals({ tokens: 100, usd: 0 }));
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({
      goalId: 'g-1',
      scope: SCOPE,
      objective: 'x',
      budget: { tokens: 50 },
    });
    await supervisor.tick();
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal).toMatchObject({
      status: 'waiting',
      waiting: { reason: 'budget', limit: 'tokens' },
    });
    await w.time.advance(1_000);
    await supervisor.tick();
    expect(launcher.calls).toHaveLength(1);
    await supervisor.command(SCOPE, 'g-1', { type: 'revise', budget: { tokens: 1_000 } });
    await supervisor.tick();
    expect(launcher.calls.map((call) => [call.kind, call.request.kind])).toEqual([
      ['launch', 'start'],
      ['resume', 'retry'],
    ]);
  });

  it('starts no run when a drain begins while the run is being marked running', async () => {
    const w = world();
    let gate: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    const store = w.store;
    const gated: GoalRuntimeStore = {
      ...store,
      runtime: {
        get: (scope, goalId) => store.runtime.get(scope, goalId),
        async save(state, goal) {
          if (state.phase === 'running' && gate === undefined) {
            await new Promise<void>((resolve) => {
              gate = resolve;
              reached!();
            });
          }
          return store.runtime.save(state, goal);
        },
      },
    };
    const { supervisor, launcher } = supervisorIn({ ...w, store: gated });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const ticking = supervisor.tick();
    await atGate;
    const draining = supervisor.drain();
    gate!();
    await Promise.all([ticking, draining]);
    expect(launcher.calls).toEqual([]);
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime.phase).toBe('dispatching');
    const next = supervisorIn(w, { owner: 'sup-b', launcher });
    await next.supervisor.tick();
    expect(launcher.calls.map((call) => call.request.runId)).toEqual(['g-1:run:1']);
  });

  it('asks the verifier once per leg and applies each of its commands once, across a conflict', async () => {
    const w = world();
    const store = w.store;
    let raced = false;
    const racing: GoalRuntimeStore = {
      ...store,
      runtime: {
        get: (scope, goalId) => store.runtime.get(scope, goalId),
        async save(state, goal) {
          if (!raced && goal !== undefined && goal.evidence.length > 0) {
            raced = true;
            const current = (await store.runtime.get(state.scope, state.goalId))!;
            await store.runtime.save({ ...current, revision: current.revision + 1 });
          }
          return store.runtime.save(state, goal);
        },
      },
    };
    let asked = 0;
    const { supervisor } = supervisorIn(
      { ...w, store: racing },
      {
        verify: ({ runId }) => {
          asked += 1;
          return [{ type: 'charge', tokens: 5 }, passed(runId)];
        },
      },
    );
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.tick();
    expect(raced).toBe(true);
    expect(asked).toBe(1);
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal).toMatchObject({
      status: 'completed',
      spent: { tokens: 5 },
    });
  });

  it('counts the goal lease lost once renewals fail for a whole TTL', async () => {
    const w = world();
    const real = w.provider;
    let failing = false;
    const unreachable: LeaseProvider = {
      acquire: (request) => real.acquire(request),
      renew: async (lease, ttlMs, options) => {
        if (failing) throw new Error('lease backend unreachable');
        return real.renew(lease, ttlMs, options);
      },
      release: (lease) => real.release(lease),
      signal: (key, signal) => real.signal(key, signal),
    };
    const launcher = fakeRunLauncher(() => 'hold');
    const a = supervisorIn({ ...w, provider: unreachable }, { launcher });
    await a.supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const ticking = a.supervisor.tick();
    await launcher.whenHeld();
    failing = true;
    await w.time.advance(20_000);
    expect(launcher.drains).toEqual([]);
    await w.time.advance(10_000);
    await ticking;
    expect(a.seen.some((event) => event.type === 'lease-lost')).toBe(true);
    expect(launcher.drains).toEqual([{ scope: SCOPE, runId: 'g-1:run:1' }]);
  });

  it('charges the leg accounting when the launcher has no ledger for the run', async () => {
    const w = world();
    const launcher = fakeRunLauncher((request) => ({
      runId: request.runId,
      result: { ...results.completed(request.runId), accounting: totals({ tokens: 9, usd: 0 }) },
    }));
    const { supervisor } = supervisorIn(w, { launcher });
    await supervisor.submit({
      goalId: 'g-1',
      scope: SCOPE,
      objective: 'x',
      policy: { maxRuns: 1 },
    });
    await supervisor.tick();
    expect((await supervisor.get(SCOPE, 'g-1'))?.goal.spent).toEqual({ tokens: 9, usd: 0 });
  });
});
