/**
 * The native `RunLauncher` (lane L4b) on the real V3 executor (lane L3b),
 * wired at the W1b integration. goal-supervisor-native.test.ts mocks the
 * executor; here nothing is mocked: the launcher's lazy import reaches the
 * real runAgent/resumeAgent V3 overloads and a real in-memory V3 store.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createGoal } from '../src/goal';
import type { GoalCommand } from '../src/goal';
import {
  createGoalSupervisor,
  createInMemoryGoalRuntimeStore,
  createNativeRunLauncher,
} from '../src/goal/runtime';
import type { RunLaunchRequest } from '../src/goal/runtime';
import { createDeferred } from '../src/internal/async-iter';
import { createInMemoryMemoryStore } from '../src/memory';
import type { MemorySeams } from '../src/memory';
import { agentRunLeaseKey, createInMemoryLeaseProvider } from '../src/ops';
import { createMockModel } from '../src/testing';
import type { AgentToolSet } from '../src/types/agent-run';

const SCOPE = 'tenant';
const T0 = Date.parse('2026-10-15T09:00:00Z');

/** A tool that parks the run until the test releases it. */
function parkedTool() {
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  const tools: AgentToolSet = {
    work: {
      description: 'Long work.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        entered.resolve();
        await released.promise;
        return 'worked';
      },
    },
  };
  return { tools, entered: entered.promise, release: () => released.resolve() };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The host's verdict that the run met the objective. */
function passed(runId: string): GoalCommand {
  return {
    type: 'evaluate',
    results: [{ criterionId: 'objective', verdict: 'passed', source: 'test', evidence: ['e-1'] }],
    evidence: [{ id: 'e-1', source: 'test', ref: 'report.xml', runId }],
  };
}

/** Memory seams whose extraction LLM waits until the test releases it. */
function heldExtraction() {
  const gate = createDeferred<void>();
  let calls = 0;
  let ids = 0;
  const seams: MemorySeams = {
    store: createInMemoryMemoryStore(),
    llm: async ({ system }) => {
      calls++;
      await gate.promise;
      return system.includes('extract')
        ? '{"facts":["prefers tea"]}'
        : '{"memory":[{"event":"ADD","text":"prefers tea"}]}';
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (fn: () => void, ms: number) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    generateId: () => `mem-${ids++}`,
    hashFn: async (text) => `h:${text}`,
  };
  return { seams, release: () => gate.resolve(), calls: () => calls };
}

function request(patch: Partial<RunLaunchRequest> = {}): RunLaunchRequest {
  return {
    scope: SCOPE,
    goalId: 'g-1',
    intentId: 'g-1#1',
    runId: 'g-1:run:1',
    attempt: 1,
    kind: 'start',
    goal: createGoal(
      { goalId: 'g-1', scope: SCOPE, objective: 'answer', specGeneration: 1 },
      { now: T0 },
    ),
    ...patch,
  };
}

describe('createNativeRunLauncher on the real V3 executor', () => {
  it('starts a V3 run, stores it as version 3 and reports its result', async () => {
    const store = createInMemoryAgentRunStoreV3();
    const model = createMockModel({ responses: [{ text: 'done' }] });
    const launcher = createNativeRunLauncher({
      store,
      options: () => ({ model, prompt: 'do the goal' }),
    });

    const launched = await launcher.launch(request());

    expect(launched.runId).toBe('g-1:run:1');
    expect(launched.result).toMatchObject({ status: 'completed', output: 'done' });
    expect(await store.load('g-1:run:1')).toMatchObject({
      version: 3,
      phase: 'terminal',
      scope: SCOPE,
      result: { status: 'completed' },
    });
  });

  it('answers a launch for a run its store already finished without calling the model again', async () => {
    const store = createInMemoryAgentRunStoreV3();
    const model = createMockModel({ responses: [{ text: 'first' }, { text: 'second' }] });
    const launcher = createNativeRunLauncher({
      store,
      options: () => ({ model, prompt: 'do the goal' }),
    });
    await launcher.launch(request());

    const again = await launcher.launch(request());

    expect(again.result).toMatchObject({ status: 'completed', output: 'first' });
  });

  it('keeps the run when its old executor still holds the native lease at a takeover, and resumes it', async () => {
    const goals = createInMemoryGoalRuntimeStore();
    const runs = createInMemoryAgentRunStoreV3();
    const provider = createInMemoryLeaseProvider();
    const model = createMockModel({ responses: [{ text: 'done' }] });
    const launcher = createNativeRunLauncher({
      store: runs,
      options: () => ({ model, prompt: 'do the goal' }),
      lease: { provider, owner: 'native-b' },
    });
    const supervisor = createGoalSupervisor({
      store: goals,
      launcher,
      lease: { provider, owner: 'sup-b' },
    });
    await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
    // The old holder's run still holds its own lease: it drains at its next renewal.
    const old = await provider.acquire({
      key: agentRunLeaseKey({ scope: SCOPE, runId: 'g:run:1' }),
      owner: 'native-a',
      ttlMs: 30_000,
    });
    expect(old).toBeDefined();
    await supervisor.tick();
    const refused = (await supervisor.get(SCOPE, 'g'))!;
    expect(refused.goal.status).toBe('active');
    expect(refused.runtime).toMatchObject({
      phase: 'dispatching',
      activeRun: { intentId: 'g#1', runId: 'g:run:1', attempt: 1 },
      runs: 1,
      retries: 0,
    });
    expect((await goals.intents.get(SCOPE, 'g#1'))?.status).toBe('claimed');
    // Refused before the run was read: nothing of it was written here.
    expect(await runs.load('g:run:1')).toBeUndefined();
    // Once the old executor lets go, the next claim resumes the same run.
    await provider.release(old!);
    await supervisor.tick();
    const later = (await supervisor.get(SCOPE, 'g'))!;
    expect(later.runtime).toMatchObject({ runs: 1, retries: 0 });
    expect((await goals.intents.get(SCOPE, 'g#1'))?.status).toBe('completed');
    expect(await runs.load('g:run:1')).toMatchObject({ result: { status: 'completed' } });
    expect(await runs.load('g:run:2')).toBeUndefined();
  });

  it('gives a launcher without a lease of its own the goal lease provider, so drain and cancel reach its run', async () => {
    for (const stop of ['drain', 'cancel'] as const) {
      const goals = createInMemoryGoalRuntimeStore();
      const runs = createInMemoryAgentRunStoreV3();
      const provider = createInMemoryLeaseProvider();
      const parked = parkedTool();
      const model = createMockModel({
        responses: [{ toolCalls: [{ toolName: 'work', id: 'w1', args: {} }] }, { text: 'done' }],
      });
      // No `lease`: the supervisor's provider (and its TTL) becomes the run's.
      const launcher = createNativeRunLauncher({
        store: runs,
        options: () => ({ model, prompt: 'do the goal', tools: parked.tools }),
      });
      const supervisor = createGoalSupervisor({
        store: goals,
        launcher,
        lease: { provider, owner: 'sup', ttlMs: 300 },
      });
      await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
      const ticking = supervisor.tick();
      await parked.entered;
      const stopping =
        stop === 'drain' ? supervisor.drain() : supervisor.command(SCOPE, 'g', { type: 'cancel' });
      // The run hears it at its next lease renewal and stops at its next step boundary.
      await pause(400);
      parked.release();
      await stopping;
      await ticking;
      const stored = await runs.load('g:run:1');
      const after = (await supervisor.get(SCOPE, 'g'))!;
      if (stop === 'drain') {
        // Resumable: no result, and the next holder resumes it.
        expect(stored?.result).toBeUndefined();
        expect(after.runtime.phase).toBe('dispatching');
        expect(after.goal.status).toBe('active');
      } else {
        expect(stored?.result).toMatchObject({ status: 'stopped', reason: 'cancelled' });
        expect(after.goal.status).toBe('cancelled');
        expect(after.runtime.phase).toBe('done');
      }
    }
  }, 30_000);

  it('settles a leg whose lease provider throws synchronously once its process died (X-2)', async () => {
    // A host process that dies mid-run: every later call to its lease
    // provider throws at once, as the composite flow's kill switch does (and
    // as a provider over a closed client may). The leg must still end: the
    // run's lease release on its way out never strands the result.
    const goals = createInMemoryGoalRuntimeStore();
    const runs = createInMemoryAgentRunStoreV3();
    const inner = createInMemoryLeaseProvider();
    let dead = false;
    const provider = new Proxy(inner, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (dead) throw new Error('host process crashed');
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const tools: AgentToolSet = {
      work: {
        description: 'The host dies while this runs.',
        parameters: { type: 'object', properties: {} },
        execute: () => {
          dead = true;
          return 'worked';
        },
      },
    };
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'work', id: 'w1', args: {} }] }, { text: 'done' }],
    });
    // No `lease`: the launcher adopts the supervisor's provider (spec §3.1).
    const launcher = createNativeRunLauncher({
      store: runs,
      options: () => ({ model, prompt: 'do the goal', tools }),
    });
    const supervisor = createGoalSupervisor({
      store: goals,
      launcher,
      lease: { provider, owner: 'p1', ttlMs: 30_000 },
    });
    await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
    const ticked = await Promise.race([
      supervisor.tick().then(
        () => 'ticked' as const,
        () => 'ticked' as const,
      ),
      pause(5_000).then(() => 'timed out' as const),
    ]);
    expect(ticked).toBe('ticked');
    // The run's own outcome was saved before its lease went back.
    expect(await runs.load('g:run:1')).toMatchObject({ phase: 'terminal' });
  }, 30_000);

  it('completes a verified goal while its memory extraction is still running, then follows it', async () => {
    const extraction = heldExtraction();
    const goals = createInMemoryGoalRuntimeStore();
    const runs = createInMemoryAgentRunStoreV3();
    const provider = createInMemoryLeaseProvider();
    const model = createMockModel({ responses: [{ text: 'done' }] });
    const launcher = createNativeRunLauncher({
      store: runs,
      options: () => ({
        model,
        prompt: 'I prefer tea',
        memory: { seams: extraction.seams, scope: { userId: 'ada' }, recall: false },
      }),
    });
    const supervisor = createGoalSupervisor({
      store: goals,
      launcher,
      lease: { provider, owner: 'sup' },
      verify: ({ runId }) => passed(runId),
    });
    await supervisor.submit({ goalId: 'g', scope: SCOPE, objective: 'x' });
    // The tick returns while the extraction LLM is still held.
    const ticked = await Promise.race([
      supervisor.tick().then(() => 'ticked' as const),
      pause(10_000).then(() => 'timed out' as const),
    ]);
    if (ticked !== 'ticked') extraction.release();
    expect(ticked).toBe('ticked');
    const mid = (await supervisor.get(SCOPE, 'g'))!;
    expect(mid.goal.status).toBe('completed');
    expect(mid.runtime.maintenance).toEqual({ status: 'pending', runId: 'g:run:1' });
    expect(await runs.load('g:run:1')).toMatchObject({
      phase: 'terminal',
      result: { status: 'completed' },
      memory: { extraction: { status: 'pending' } },
    });
    // Once the extraction ends, the next tick sees its maintenance settle.
    extraction.release();
    for (let wait = 0; wait < 200; wait++) {
      if ((await runs.load('g:run:1'))?.memory?.extraction?.status !== 'pending') break;
      await pause(25);
    }
    expect(extraction.calls()).toBeGreaterThan(0);
    await supervisor.tick();
    const end = (await supervisor.get(SCOPE, 'g'))!;
    expect(end.goal.status).toBe('completed');
    expect(end.runtime.maintenance).toEqual({ status: 'complete', runId: 'g:run:1' });
    expect(end.runtime.maintenanceRuns).toBeUndefined();
  }, 30_000);
});
