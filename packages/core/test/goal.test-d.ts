/**
 * Type contract of `@deuz-sdk/core/goal` (2.3) and of the native run listing
 * and lease types, checked by `npm run test:types`.
 */
import { describe, expectTypeOf, it } from 'vitest';
import { createGoal, createInMemoryGoalStore, transitionGoal } from '../src/goal';
import type {
  GoalCommand,
  GoalRecord,
  GoalStatus,
  GoalStore,
  GoalTransition,
  GoalWaitReason,
  GoalWaitRequest,
  GoalWaiting,
} from '../src/goal';
import type {
  AgentRunLeaseOptions,
  AgentRunListPage,
  AgentRunPhase,
  AgentRunStore,
  AgentRunSummary,
} from '../src/agent';
import { createInMemoryAgentRunStore } from '../src/agent';
import { agentRunLeaseKey, findStaleAgentRuns } from '../src/ops';

describe('goal types (2.3)', () => {
  it('names the statuses and waiting reasons', () => {
    expectTypeOf<GoalStatus>().toEqualTypeOf<
      'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'
    >();
    expectTypeOf<GoalWaitReason>().toEqualTypeOf<
      'user' | 'event' | 'dependency' | 'wakeup' | 'budget'
    >();
    expectTypeOf<GoalWaiting['reason']>().toEqualTypeOf<GoalWaitReason>();
  });

  it('keeps the wait a spent budget interrupted, never another budget wait', () => {
    expectTypeOf<Extract<GoalWaiting, { reason: 'budget' }>['interrupted']>().toEqualTypeOf<
      Exclude<GoalWaiting, { reason: 'budget' }> | undefined
    >();
  });

  it('enters every wait but a budget one by command', () => {
    expectTypeOf<GoalWaitRequest['reason']>().toEqualTypeOf<
      'user' | 'event' | 'dependency' | 'wakeup'
    >();
    const wait: GoalCommand = { type: 'wait', wait: { reason: 'wakeup', at: 1 } };
    // @ts-expect-error a budget wait only comes from a charge
    const budget: GoalCommand = { type: 'wait', wait: { reason: 'budget', limit: 'usd' } };
    void wait;
    void budget;
  });

  it('returns records and transitions', () => {
    const goal = createGoal({ goalId: 'g', scope: 's', objective: 'x' }, { now: 1 });
    expectTypeOf(goal).toEqualTypeOf<GoalRecord>();
    expectTypeOf(goal.version).toEqualTypeOf<1>();
    expectTypeOf(
      transitionGoal(goal, { type: 'tick' }, { now: 2 }),
    ).toEqualTypeOf<GoalTransition>();
    expectTypeOf(createInMemoryGoalStore()).toMatchTypeOf<GoalStore>();
  });
});

describe('native run discovery and lease types (2.3)', () => {
  it('lists runs from a store that can', () => {
    expectTypeOf<AgentRunPhase>().toEqualTypeOf<'running' | 'finalizing' | 'terminal'>();
    expectTypeOf<NonNullable<AgentRunStore['list']>>().returns.toEqualTypeOf<
      Promise<AgentRunListPage>
    >();
    expectTypeOf(createInMemoryAgentRunStore().list).returns.toEqualTypeOf<
      Promise<AgentRunListPage>
    >();
    expectTypeOf(findStaleAgentRuns).returns.toEqualTypeOf<Promise<AgentRunSummary[]>>();
  });

  it('keys a run lease by scope and run ID', () => {
    expectTypeOf(agentRunLeaseKey).parameter(0).toEqualTypeOf<{ scope: string; runId: string }>();
    expectTypeOf<AgentRunLeaseOptions['ttlMs']>().toEqualTypeOf<number | undefined>();
  });
});
