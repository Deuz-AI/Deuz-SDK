/**
 * The native `RunLauncher` (lane L4b) on the real V3 executor (lane L3b),
 * wired at the W1b integration. goal-supervisor-native.test.ts mocks the
 * executor; here nothing is mocked: the launcher's lazy import reaches the
 * real runAgent/resumeAgent V3 overloads and a real in-memory V3 store.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createGoal } from '../src/goal';
import { createNativeRunLauncher } from '../src/goal/runtime';
import type { RunLaunchRequest } from '../src/goal/runtime';
import { createMockModel } from '../src/testing';

const SCOPE = 'tenant';
const T0 = Date.parse('2026-10-15T09:00:00Z');

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
});
