/**
 * The goal supervisor's host surface (2.4, spec §3.1): submit, get/list,
 * dispatch, command, resume, updatePolicy and events, on the real in-memory
 * goal runtime store with a scripted launcher. How a tick drives a goal is in
 * `goal-supervisor-drive.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { GoalError, createGoalEvent } from '../src/goal';
import type { GoalCommand, GoalEvent } from '../src/goal';
import {
  DEFAULT_GOAL_RUNTIME_POLICY,
  createGoalSupervisor,
  createInMemoryGoalRuntimeStore,
  goalDeliveryDigest,
  goalInboxKey,
  goalLeaseKey,
} from '../src/goal/runtime';
import type {
  GoalRuntimeStore,
  GoalSupervisorEvent,
  GoalSupervisorOptions,
} from '../src/goal/runtime';
import { createInMemoryLeaseProvider } from '../src/ops';
import type { ObserveEvent } from '../src/types/observe';
import { fakeRunLauncher } from './fixtures/fake-run-launcher';
import { manualClock } from './fixtures/manual-clock';

const T0 = Date.parse('2026-10-15T09:00:00Z');
const SCOPE = 'tenant-a';

function setup(
  options: Partial<GoalSupervisorOptions> & {
    wrap?: (store: GoalRuntimeStore) => GoalRuntimeStore;
  } = {},
) {
  const time = manualClock(T0);
  const observed: ObserveEvent[] = [];
  const store = createInMemoryGoalRuntimeStore({ deps: { clock: time.clock } });
  const provider = createInMemoryLeaseProvider({ clock: time.clock });
  const launcher = fakeRunLauncher();
  const { wrap, ...rest } = options;
  const supervisor = createGoalSupervisor({
    store: wrap ? wrap(store) : store,
    launcher,
    lease: { provider, owner: 'sup-a' },
    deps: {
      clock: time.clock,
      observer: { emit: (event) => void observed.push(event) },
    },
    ...rest,
  });
  return { time, store, provider, launcher, supervisor, observed };
}

const spans = (observed: ObserveEvent[], name: string) =>
  observed.filter(
    (event) =>
      event.type === 'operation.completed' && 'operation' in event && event.operation === name,
  );

describe('submit, get and list', () => {
  it('records the goal, its runtime state and a start intent in one write', async () => {
    const { store, supervisor } = setup();
    const record = vi.spyOn(store.intents, 'record');
    const supervision = await supervisor.submit({
      goalId: 'g-1',
      scope: SCOPE,
      objective: 'Ship the report.',
    });
    expect(supervision.goal).toMatchObject({
      goalId: 'g-1',
      scope: SCOPE,
      revision: 1,
      status: 'active',
      specGeneration: 1,
      runId: 'g-1:run:1',
    });
    expect(supervision.runtime).toMatchObject({
      goalId: 'g-1',
      scope: SCOPE,
      revision: 1,
      phase: 'dispatching',
      runs: 1,
      retries: 0,
      activeRun: { intentId: 'g-1#1', runId: 'g-1:run:1', attempt: 1, startedAt: T0 },
      createdAt: T0,
      updatedAt: T0,
    });
    expect(supervision.runtime.policy).toEqual({
      ...DEFAULT_GOAL_RUNTIME_POLICY,
      retryDelaysMs: [1_000, 5_000, 30_000],
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(await store.intents.get(SCOPE, 'g-1#1')).toMatchObject({
      kind: 'start',
      status: 'pending',
      runId: 'g-1:run:1',
      attempt: 1,
      cause: { command: 'submit' },
    });
    expect(await supervisor.get(SCOPE, 'g-1')).toEqual(supervision);
  });

  it('keeps an explicit spec generation, and records no intent with start: false', async () => {
    const { store, supervisor } = setup();
    const supervision = await supervisor.submit({
      goalId: 'g-2',
      scope: SCOPE,
      objective: 'Wait for the go-ahead.',
      specGeneration: 4,
      start: false,
    });
    expect(supervision.goal.specGeneration).toBe(4);
    expect(supervision.goal.runId).toBeUndefined();
    expect(supervision.runtime).toMatchObject({ phase: 'idle', runs: 0, revision: 1 });
    expect(supervision.runtime.activeRun).toBeUndefined();
    expect((await store.intents.list({ scope: SCOPE })).intents).toEqual([]);
  });

  it('merges the policy: defaults, then the supervisor options, then the goal', async () => {
    const { supervisor } = setup({ policy: { maxRuns: 4, retryDelaysMs: [10] } });
    const { runtime } = await supervisor.submit({
      goalId: 'g-3',
      scope: SCOPE,
      objective: 'x',
      policy: { maxRetries: 1 },
    });
    expect(runtime.policy).toEqual({
      maxRuns: 4,
      maxRetries: 1,
      retryDelaysMs: [10],
      retainPayloadMs: DEFAULT_GOAL_RUNTIME_POLICY.retainPayloadMs,
    });
    await expect(
      supervisor.submit({ goalId: 'g-4', scope: SCOPE, objective: 'x', policy: { maxRuns: -1 } }),
    ).rejects.toThrow(TypeError);
  });

  it('keeps goal ids globally unique, whatever the scope', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    for (const scope of [SCOPE, 'tenant-b'])
      await expect(
        supervisor.submit({ goalId: 'g-1', scope, objective: 'y', start: false }),
      ).rejects.toMatchObject({ name: 'GoalError', code: 'revision_conflict' });
  });

  it('reads a goal only in its own scope and lists one scope', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    await supervisor.submit({ goalId: 'g-2', scope: 'tenant-b', objective: 'y' });
    expect(await supervisor.get('tenant-b', 'g-1')).toBeUndefined();
    expect(await supervisor.get(SCOPE, 'missing')).toBeUndefined();
    const page = await supervisor.list({ scope: SCOPE });
    expect(page.goals.map((goal) => goal.goalId)).toEqual(['g-1']);
    await expect(supervisor.list({ scope: undefined as never })).rejects.toThrow(TypeError);
  });
});

describe('dispatch', () => {
  const eventFor = (goalId: string, patch: Partial<GoalEvent> = {}): GoalEvent => ({
    ...createGoalEvent({
      scope: SCOPE,
      goalId,
      source: { type: 'user' },
      key: 'k-1',
      at: T0,
    }),
    ...patch,
  });

  it('queues an event once, digested as the scheduler and the webhook digest theirs', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    const event = eventFor('g-1');
    const first = await supervisor.dispatch(event);
    expect(first.status).toBe('enqueued');
    expect(first.entry).toMatchObject({
      id: goalInboxKey(SCOPE, 'host', 'k-1'),
      namespace: 'host',
      deliveryId: 'k-1',
      disposition: 'pending',
      digest: await goalDeliveryDigest({ scope: SCOPE, goalId: 'g-1', event }),
    });
    // A sender's retry arrives later: the same delivery.
    expect((await supervisor.dispatch({ ...event, at: T0 + 5_000 })).status).toBe('duplicate');
    const conflict = supervisor.dispatch({ ...event, source: { type: 'signal' } });
    await expect(conflict).rejects.toBeInstanceOf(GoalError);
    await expect(conflict).rejects.toMatchObject({ code: 'delivery_conflict' });
  });

  it('takes a namespace, a delivery id and a payload', async () => {
    const { store, supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    const payload = { body: '{"ok":true}', mediaType: 'application/json' };
    const result = await supervisor.dispatch(eventFor('g-1'), {
      namespace: 'webhook:ci',
      deliveryId: 'd-9',
      payload,
    });
    const id = goalInboxKey(SCOPE, 'webhook:ci', 'd-9');
    expect(result.entry.id).toBe(id);
    expect((await store.inbox.get(SCOPE, id))?.payload).toEqual(payload);
  });

  it('refuses an event for a goal that is not in its scope', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: 'tenant-b', objective: 'x', start: false });
    await expect(supervisor.dispatch(eventFor('g-1'))).rejects.toMatchObject({
      code: 'scope_mismatch',
    });
  });
});

describe('command', () => {
  const evidence: GoalCommand = {
    type: 'evidence',
    evidence: [{ id: 'e-1', source: 'test', ref: 'report.xml' }],
  };

  it('applies a host command at the expected revision, fenced with the runtime state', async () => {
    const { time, supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await time.advance(10);
    const transition = await supervisor.command(SCOPE, 'g-1', evidence, { expectedRevision: 1 });
    expect(transition).toMatchObject({ changed: true, outcome: 'applied' });
    const after = await supervisor.get(SCOPE, 'g-1');
    expect(after?.goal.revision).toBe(2);
    expect(after?.runtime).toMatchObject({ revision: 2, updatedAt: T0 + 10 });
    await expect(
      supervisor.command(SCOPE, 'g-1', evidence, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ name: 'GoalError', code: 'revision_conflict' });
    // Nothing to change: nothing written.
    const again = await supervisor.command(SCOPE, 'g-1', evidence);
    expect(again).toMatchObject({ changed: false, outcome: 'ignored' });
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime.revision).toBe(2);
    await expect(supervisor.command('tenant-b', 'g-1', evidence)).rejects.toMatchObject({
      code: 'scope_mismatch',
    });
  });

  it('re-reads and applies again when another writer moved the runtime state', async () => {
    let raced = false;
    const { supervisor } = setup({
      wrap: (store) => ({
        ...store,
        runtime: {
          get: (scope, goalId) => store.runtime.get(scope, goalId),
          async save(state, goal) {
            if (!raced && goal && state.revision > 1) {
              raced = true;
              const current = (await store.runtime.get(state.scope, state.goalId))!;
              await store.runtime.save({ ...current, revision: current.revision + 1 });
            }
            return store.runtime.save(state, goal);
          },
        },
      }),
    });
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    const transition = await supervisor.command(SCOPE, 'g-1', evidence, { expectedRevision: 1 });
    expect(transition.changed).toBe(true);
    expect(await supervisor.get(SCOPE, 'g-1')).toMatchObject({
      goal: { revision: 2 },
      runtime: { revision: 3 },
    });
  });

  it('reports a new spec generation', async () => {
    const { supervisor, observed } = setup();
    const seen: GoalSupervisorEvent[] = [];
    const controller = new AbortController();
    const reading = (async () => {
      for await (const event of supervisor.events({ signal: controller.signal })) seen.push(event);
    })();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', { type: 'revise', objective: 'y' });
    await supervisor.command(SCOPE, 'g-1', { type: 'revise', meta: { note: 'n' } });
    controller.abort();
    await reading;
    expect(seen).toEqual([
      { type: 'generation-changed', scope: SCOPE, goalId: 'g-1', specGeneration: 2 },
    ]);
    const generation = spans(observed, 'deuz.goal.generation');
    expect(generation).toHaveLength(1);
    expect(generation[0]).toMatchObject({
      subsystem: 'goal',
      attributes: { 'deuz.goal.id': 'g-1', 'deuz.goal.spec_generation': 2 },
    });
  });

  it('marks the runtime done when a command ends a goal no run works on', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', { type: 'fail', reason: 'obsolete' });
    expect(await supervisor.get(SCOPE, 'g-1')).toMatchObject({
      goal: { status: 'failed' },
      runtime: { phase: 'done' },
    });
  });

  it('records a cancel and asks the run to stop, leaving the goal for the cancel to apply', async () => {
    const { supervisor, launcher, provider, observed } = setup();
    const { goal } = await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x' });
    const holder = await provider.acquire({
      key: goalLeaseKey(SCOPE, 'g-1'),
      owner: 'sup-b',
      ttlMs: 30_000,
    });
    const transition = await supervisor.command(SCOPE, 'g-1', {
      type: 'cancel',
      reason: 'not needed',
    });
    expect(transition).toEqual({ record: goal, changed: false, outcome: 'applied' });
    const after = await supervisor.get(SCOPE, 'g-1');
    expect(after?.goal).toEqual(goal);
    expect(after?.runtime).toMatchObject({
      revision: 2,
      cancel: { requestedAt: T0, reason: 'not needed' },
    });
    expect(after?.runtime.cancel?.appliedAt).toBeUndefined();
    expect(launcher.cancels).toEqual([{ scope: SCOPE, runId: 'g-1:run:1', reason: 'not needed' }]);
    // The goal's holder, wherever it runs, hears of it at its next renewal.
    const renewal = await provider.renew(holder!, 30_000);
    expect(renewal).toMatchObject({ held: true, signals: ['cancel'] });
    expect(spans(observed, 'deuz.goal.cancel_requested')[0]).toMatchObject({
      attributes: { 'deuz.goal.id': 'g-1' },
    });
    // A second cancel changes nothing.
    expect(await supervisor.command(SCOPE, 'g-1', { type: 'cancel' })).toMatchObject({
      changed: false,
      outcome: 'ignored',
      reason: 'unchanged',
    });
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime.revision).toBe(2);
  });

  it('answers a cancel of an ended goal as the goal does', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', { type: 'fail', reason: 'obsolete' });
    expect(await supervisor.command(SCOPE, 'g-1', { type: 'cancel' })).toMatchObject({
      changed: false,
      outcome: 'rejected',
      reason: 'terminal',
    });
    expect((await supervisor.get(SCOPE, 'g-1'))?.runtime.cancel).toBeUndefined();
  });
});

describe('updatePolicy', () => {
  it('changes the limits at the expected runtime revision only', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    const updated = await supervisor.updatePolicy(
      SCOPE,
      'g-1',
      { maxRuns: 12 },
      { expectedRevision: 1 },
    );
    expect(updated).toMatchObject({ revision: 2, policy: { maxRuns: 12, maxRetries: 3 } });
    await expect(
      supervisor.updatePolicy(SCOPE, 'g-1', { maxRuns: 20 }, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ name: 'GoalError', code: 'revision_conflict' });
    await expect(
      supervisor.updatePolicy(SCOPE, 'g-1', { maxRetries: 1.5 }, { expectedRevision: 2 }),
    ).rejects.toThrow(TypeError);
    await expect(
      supervisor.updatePolicy('tenant-b', 'g-1', { maxRuns: 20 }, { expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'scope_mismatch' });
  });

  it('keeps a recorded cancel', async () => {
    const { supervisor } = setup();
    await supervisor.submit({ goalId: 'g-1', scope: SCOPE, objective: 'x', start: false });
    await supervisor.command(SCOPE, 'g-1', { type: 'cancel' });
    const updated = await supervisor.updatePolicy(
      SCOPE,
      'g-1',
      { maxRuns: 2 },
      { expectedRevision: 2 },
    );
    expect(updated.cancel).toEqual({ requestedAt: T0 });
  });
});
