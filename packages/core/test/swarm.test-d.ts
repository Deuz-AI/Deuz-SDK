import { expectTypeOf, test } from 'vitest';
import { createAgent } from '../src/agent';
import type {
  AgentResult,
  AgentRunEnvelope,
  BudgetAdmission,
  NativeExecutionContext,
} from '../src/agent';
import { createInMemorySwarmStore, createRounds, createSwarm, SwarmLeaseError } from '../src/swarm';
import type {
  RoundsDecision,
  RoundsGroupPlan,
  Swarm,
  SwarmCancelRequest,
  SwarmLeaseOptions,
  SwarmRecovery,
  SwarmResumeOptions,
  SwarmRunQuery,
  SwarmAgentBinding,
  SwarmChannelEntry,
  SwarmChannelPost,
  SwarmDynamicLimits,
  SwarmEvent,
  SwarmFailureContext,
  SwarmHandle,
  SwarmKey,
  SwarmOptions,
  SwarmOutcome,
  SwarmReducerContext,
  SwarmRounds,
  SwarmRunRecord,
  SwarmSpawnContext,
  SwarmSpawnRequest,
  SwarmStore,
  SwarmStoreCapability,
  SwarmTask,
  SwarmTaskResult,
  SwarmTaskStatus,
} from '../src/swarm';
import { createSqliteSwarmStore } from '../src/node/swarm-sqlite';
import type { SqliteSwarmStore } from '../src/node/swarm-sqlite';
import type { LanguageModel } from '../src/types/model';
import type { StandardSchemaV1 } from '../src/types/schema';

declare const model: LanguageModel;
declare const schema: StandardSchemaV1<unknown, { answer: number }>;
declare const outcome: SwarmOutcome;

test('swarm methods infer handles and durable typed event cursors', () => {
  const swarm = createSwarm({
    agents: { worker: createAgent({ model }) },
    store: createInMemorySwarmStore(),
  });
  expectTypeOf(swarm).toEqualTypeOf<Swarm>();
  expectTypeOf(
    swarm.run({ scope: 'tenant', tasks: [{ id: 'a', agent: 'worker', prompt: 'answer' }] }),
  ).toEqualTypeOf<Promise<SwarmHandle>>();
  expectTypeOf(
    swarm.resume({
      scope: 'tenant',
      runId: 'run',
      approvals: { a: [{ approvalId: 'call', approved: true }] },
    }),
  ).toEqualTypeOf<Promise<SwarmHandle>>();
  expectTypeOf(swarm.events({ scope: 'tenant', runId: 'run' }, { afterSequence: 1 })).toEqualTypeOf<
    AsyncIterable<SwarmEvent>
  >();
  expectTypeOf<SwarmHandle['result']>().toEqualTypeOf<Promise<SwarmOutcome>>();
  expectTypeOf<ReturnType<SwarmHandle['cancel']>>().toEqualTypeOf<Promise<void>>();
  // @ts-expect-error Persisted runs always require an application tenant/workflow scope.
  void swarm.run({ tasks: [] });
  void swarm.resume({
    scope: 'tenant',
    runId: 'run',
    // @ts-expect-error Approval verdicts are keyed by task, not a flat cross-task array.
    approvals: [{ approvalId: 'call', approved: true }],
  });
});

test('agent bindings preserve native validation and tri-state verifier contracts', () => {
  const binding: SwarmAgentBinding = {
    agent: createAgent({ model }),
    output: { schema },
    maxOutputAttempts: 2,
    maxVerifyAttempts: 3,
    toolsContext: { lookup: { tenant: 'a' } },
    tools: {
      lookup: { parameters: { type: 'object', properties: {} }, execute: () => ({ answer: 42 }) },
    },
    verify(context) {
      // A heterogeneous task registry cannot promise one task's T for every task.
      expectTypeOf(context.output).toEqualTypeOf<unknown>();
      expectTypeOf(context.execution).toEqualTypeOf<NativeExecutionContext>();
      return { status: 'verified' };
    },
  };
  void binding;
  const invalidOutput: SwarmAgentBinding = {
    agent: createAgent({ model }),
    // @ts-expect-error Raw JSON schema must supply runtime validation.
    output: { schema: { type: 'object' } },
  };
  const invalidVerifier: SwarmAgentBinding = {
    agent: createAgent({ model }),
    // @ts-expect-error Boolean completion hooks cannot stand in for a verified verdict.
    verify: () => true,
  };
  void invalidOutput;
  void invalidVerifier;
});

test('reducer inputs remain unknown and context exposes shared accounting', () => {
  void createSwarm({
    agents: {},
    store: createInMemorySwarmStore(),
    reducers: {
      sum: {
        execute(results, context) {
          expectTypeOf(results).toEqualTypeOf<Readonly<Record<string, SwarmTaskResult>>>();
          expectTypeOf(context).toEqualTypeOf<SwarmReducerContext>();
          expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>();
          expectTypeOf(context.execution).toEqualTypeOf<NativeExecutionContext>();
          // @ts-expect-error Dependency output must be checked before arithmetic.
          const unsafe: number = results.first?.output;
          void unsafe;
          return 42;
        },
      },
    },
  });
});

test('task kinds and terminal result acceptance stay explicit', () => {
  const valid: SwarmTask = { id: 'reduce', reducer: 'sum', dependsOn: ['a', 'b'] as const };
  // @ts-expect-error One task cannot be both an agent invocation and a reducer.
  const mixed: SwarmTask = { id: 'mixed', agent: 'worker', prompt: 'answer', reducer: 'sum' };
  // @ts-expect-error Agent tasks require a prompt.
  const missingPrompt: SwarmTask = { id: 'agent', agent: 'worker' };
  void valid;
  void mixed;
  void missingPrompt;
  const agentResult = outcome.tasks[0]?.result?.agentResult;
  expectTypeOf(agentResult).toEqualTypeOf<AgentResult<unknown> | undefined>();
  if (agentResult?.status === 'completed')
    expectTypeOf(agentResult.output).toEqualTypeOf<unknown>();
  else if (agentResult) {
    // @ts-expect-error Suspended, failed and stopped agent runs have no accepted output.
    void agentResult.output;
  }
  expectTypeOf<SwarmTaskStatus>().toEqualTypeOf<
    | 'pending'
    | 'running'
    | 'suspended'
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'cancelled'
    | 'needs_reconciliation'
  >();
});

test('SQLite adds an asynchronous close without changing the swarm store contract', () => {
  expectTypeOf(createSqliteSwarmStore({ path: ':memory:' })).toEqualTypeOf<SqliteSwarmStore>();
  expectTypeOf<ReturnType<SqliteSwarmStore['close']>>().toEqualTypeOf<Promise<void>>();
});

test('2.2 SwarmStore.head is an optional run-record read', () => {
  expectTypeOf<SwarmStore['head']>().toEqualTypeOf<
    ((key: SwarmKey) => Promise<SwarmRunRecord | undefined>) | undefined
  >();
});

test('2.2 dynamic swarm surface: spawn requests, hooks, limits and capabilities', () => {
  expectTypeOf<SwarmReducerContext['spawn']>().toEqualTypeOf<
    (requests: readonly SwarmSpawnRequest[]) => void
  >();
  const agentSpawn: SwarmSpawnRequest = { key: 'a', agent: 'worker', prompt: 'go' };
  const reducerSpawn: SwarmSpawnRequest = { key: 'b', reducer: 'join', dependsOn: ['x/a'] };
  expectTypeOf([agentSpawn, reducerSpawn]).toExtend<readonly SwarmSpawnRequest[]>();
  // @ts-expect-error an agent spawn needs a prompt
  const missingPrompt: SwarmSpawnRequest = { key: 'a', agent: 'worker' };
  void missingPrompt;
  expectTypeOf<SwarmAgentBinding['spawn']>().toEqualTypeOf<
    | ((
        output: unknown,
        context: SwarmSpawnContext,
      ) => readonly SwarmSpawnRequest[] | Promise<readonly SwarmSpawnRequest[]>)
    | undefined
  >();
  expectTypeOf<SwarmFailureContext['error']>().toEqualTypeOf<{
    name: string;
    message: string;
    code?: string;
  }>();
  expectTypeOf<SwarmOptions['dynamic']>().toEqualTypeOf<SwarmDynamicLimits | undefined>();
  expectTypeOf<SwarmRunRecord['version']>().toEqualTypeOf<1 | 2>();
  expectTypeOf<SwarmStore['capabilities']>().toEqualTypeOf<
    readonly SwarmStoreCapability[] | undefined
  >();
  expectTypeOf<'task.spawned'>().toExtend<SwarmEvent['type']>();
  expectTypeOf<SwarmTask['timeoutMs']>().toEqualTypeOf<number | undefined>();
});

test('2.2 blackboard, soft dependencies and rounds surface', () => {
  expectTypeOf<SwarmStoreCapability>().toEqualTypeOf<'spawn' | 'channels' | 'list'>();
  expectTypeOf<SwarmTask['group']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<SwarmTask['after']>().toEqualTypeOf<readonly string[] | undefined>();
  expectTypeOf<SwarmAgentBinding['blackboard']>().toEqualTypeOf<
    { read?: 'group' | readonly string[]; post?: boolean } | undefined
  >();
  expectTypeOf<SwarmReducerContext['settled']>().toEqualTypeOf<
    Readonly<Record<string, SwarmTaskStatus>>
  >();
  expectTypeOf<SwarmReducerContext['readChannel']>().toEqualTypeOf<
    (channel: string, afterSequence?: number, limit?: number) => Promise<SwarmChannelEntry[]>
  >();
  expectTypeOf<SwarmStore['readChannel']>().toEqualTypeOf<
    | ((
        key: SwarmKey,
        channel: string,
        afterSequence: number,
        limit: number,
      ) => Promise<SwarmChannelEntry[]>)
    | undefined
  >();
  expectTypeOf<'channel.posted'>().toExtend<SwarmEvent['type']>();
  expectTypeOf<SwarmChannelPost>().toEqualTypeOf<Omit<SwarmChannelEntry, 'sequence'>>();
  const rounds = createRounds({
    id: 'r',
    maxRounds: 2,
    initial: { g: { agent: 'worker', count: 1, prompt: 'go' } },
    consolidate: (input) => {
      expectTypeOf(input.round).toEqualTypeOf<number>();
      expectTypeOf(input.groups).toEqualTypeOf<
        Readonly<Record<string, readonly SwarmTaskResult[]>>
      >();
      return { stop: true };
    },
  });
  expectTypeOf(rounds).toEqualTypeOf<SwarmRounds>();
  expectTypeOf<RoundsDecision['groups']>().toEqualTypeOf<
    Readonly<Record<string, RoundsGroupPlan>> | undefined
  >();
});

test('2.2 durability operations surface', () => {
  expectTypeOf<ReturnType<SwarmHandle['drain']>>().toEqualTypeOf<Promise<SwarmOutcome>>();
  expectTypeOf<SwarmCancelRequest>().toEqualTypeOf<'signalled' | 'recorded' | 'settled'>();
  expectTypeOf<ReturnType<Swarm['requestCancel']>>().toEqualTypeOf<Promise<SwarmCancelRequest>>();
  expectTypeOf<Parameters<Swarm['recover']>>().toEqualTypeOf<
    [options?: { scope?: string; limit?: number }]
  >();
  expectTypeOf<ReturnType<Swarm['recover']>>().toEqualTypeOf<Promise<SwarmRecovery>>();
  expectTypeOf<SwarmRecovery>().toEqualTypeOf<{
    handles: SwarmHandle[];
    failed: { key: SwarmKey; error: unknown }[];
  }>();
  expectTypeOf<SwarmResumeOptions['expectedRevision']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<SwarmResumeOptions['expectedStatus']>().toEqualTypeOf<
    SwarmRunRecord['status'] | undefined
  >();
  expectTypeOf<SwarmOptions['lease']>().toEqualTypeOf<SwarmLeaseOptions | undefined>();
  expectTypeOf<SwarmOptions['admission']>().toEqualTypeOf<BudgetAdmission | undefined>();
  expectTypeOf<SwarmLeaseOptions['ttlMs']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<SwarmStore['listRuns']>().toEqualTypeOf<
    ((query: SwarmRunQuery) => Promise<SwarmRunRecord[]>) | undefined
  >();
  expectTypeOf<'run.drained'>().toExtend<SwarmEvent['type']>();
  expectTypeOf(new SwarmLeaseError('held').code).toEqualTypeOf<'held' | 'lost'>();
  expectTypeOf<AgentRunEnvelope['revision']>().toEqualTypeOf<number | undefined>();
});
