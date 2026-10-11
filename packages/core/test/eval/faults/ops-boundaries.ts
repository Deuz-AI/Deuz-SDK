/**
 * Faults in the operations layer: the swarm's cancel commit, a native run's
 * lease (lost mid-run, or a first renewal that fails), the budget store's
 * admission (a serialization failure, 40001) and settlement, and a dynamic
 * swarm's spawn commit.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import { createInMemoryBudgetStore } from '../../../src/budget-store';
import { createExecutionContext } from '../../../src/execution-policy';
import { createDeferred } from '../../../src/internal/async-iter';
import { createInMemoryLeaseProvider } from '../../../src/ops';
import { createInMemorySwarmStore, createSwarm } from '../../../src/swarm';
import type { AgentToolContext } from '../../../src/types/agent-run';
import type { BudgetStore } from '../../../src/types/budget-store';
import type { LeaseProvider } from '../../../src/types/lease';
import type {
  SwarmCommit,
  SwarmOptions,
  SwarmReducerBinding,
  SwarmStore,
} from '../../../src/types/swarm';
import type { EvalTaskContext, EvalTaskManifest } from '../../../src/testing';
import { manualClock } from '../../fixtures/manual-clock';
import { MOCK, costKept, mockPrices, parameters, ranOnce, scripted } from './support';

/** A reducer whose run is the external effect: a report sent once per task. */
function sendReport(context: EvalTaskContext): SwarmReducerBinding {
  return {
    execute: (_results, task) => {
      const effects = ((context.store.effects as string[] | undefined) ??= []);
      context.effect(`report:${task.taskId}`);
      effects.push(`report:${task.taskId}`);
      return 'sent';
    },
  };
}

export const swarmCancelCommit: EvalTaskManifest = {
  id: 'fault/swarm-cancel-commit',
  version: 1,
  title: "A swarm's cancel commit fails at start: its executor still lets go",
  tags: ['fault', 'swarm', 'ops'],
  model: MOCK,
  fault: { boundary: 'swarm-cancel-commit', recovery: 'resume-after-cleanup' },
  acceptance: [
    { name: 'the resumed run completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('report:a'),
  ],
  async run(context) {
    const base = createInMemorySwarmStore();
    let armed = true;
    const store: SwarmStore = {
      ...base,
      async commit(change: SwarmCommit) {
        if (armed && (change.events ?? []).some((event) => event.type === 'run.cancelled')) {
          armed = false;
          context.interrupt('swarm-cancel-commit');
          throw new Error('injected store outage');
        }
        return base.commit(change);
      },
    };
    const swarm = createSwarm({ agents: {}, store, reducers: { work: sendReport(context) } });
    const key = { scope: 'eval', runId: 'cancel' };
    const aborted = new AbortController();
    aborted.abort();
    const failed = await swarm
      .run({
        ...key,
        tasks: [{ id: 'a', reducer: 'work', replay: 'safe' }],
        signal: aborted.signal,
      })
      .then(
        () => false,
        () => true,
      );
    // Before 2.3 the failed executor kept its claim: this resume threw
    // 'Swarm run already has an executor'.
    const outcome = await (await swarm.resume(key)).result;
    return {
      status: outcome.run.status === 'completed' ? 'completed' : 'failed',
      output: outcome.tasks.map((task) => task.status),
      recovery: failed ? 'resume-after-cleanup' : 'other',
    };
  },
};

export const leaseLoss: EvalTaskManifest = {
  id: 'fault/lease-loss',
  version: 1,
  title: 'The lease is lost while a tool runs; the next executor finishes the run',
  tags: ['fault', 'native', 'lease'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Sync the catalog.' }] },
  fault: { boundary: 'lease-loss', recovery: 'next-executor-resumes' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('sync:1:s1'),
    costKept,
  ],
  async run(context) {
    const time = manualClock(0);
    const leases = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemoryAgentRunStore({ clock: time.clock });
    let down = false;
    const flaky: LeaseProvider = {
      ...leases,
      renew: async (lease, ttlMs, options) => {
        if (down) throw new Error('lease provider down');
        return leases.renew(lease, ttlMs, options);
      },
    };
    const effects: string[] = [];
    context.store.effects = effects;
    const entered = createDeferred<void>();
    let executions = 0;
    const { model, calls } = scripted([
      { toolCalls: [{ toolName: 'sync', id: 's1', args: {} }] },
      { text: 'Synced.' },
    ]);
    const options = {
      model,
      messages: context.messages,
      session: { store, runId: 'job', scope: 'eval' },
      tools: {
        sync: {
          parameters,
          // The catalog service keys a sync by its call identity and drops
          // repeats. Any sync it accepts syncs the catalog, so a replay under
          // another identity is a repeat.
          replay: 'idempotent' as const,
          async execute(_args: unknown, call: AgentToolContext) {
            executions += 1;
            const key = `sync:${call.modelStep}:${call.toolCallId}`;
            if (!effects.includes(key)) {
              context.effect('sync:catalog');
              effects.push(key);
            }
            entered.resolve();
            if (executions === 1)
              // The first executor is stuck here when its lease lapses.
              await new Promise<void>((_resolve, reject) =>
                call.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                }),
              );
            return 'synced';
          },
        },
      },
      deps: { clock: time.clock, observer: context.observer, priceProvider: mockPrices },
    };
    const first = runAgent({ ...options, lease: { provider: flaky, owner: 'a', ttlMs: 300 } });
    await entered.promise;
    down = true;
    context.interrupt('lease-loss');
    await time.advance(400);
    const lost = await first;
    down = false;
    const resumed = await resumeAgent({
      ...options,
      lease: { provider: leases, owner: 'b', ttlMs: 300 },
    });
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        lost.status === 'failed' && lost.error.code === 'lease_lost' && executions === 2
          ? 'next-executor-resumes'
          : 'other',
    };
  },
};

export const leaseRenewFailure: EvalTaskManifest = {
  id: 'fault/lease-renew-failure',
  version: 1,
  title: 'The first lease renewal fails: the run writes nothing and gives the key back',
  tags: ['fault', 'native', 'lease'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Do the job.' }] },
  fault: { boundary: 'lease-renew-failure', recovery: 'next-executor-runs' },
  acceptance: [{ name: 'completes', check: (outcome) => outcome.status === 'completed' }, costKept],
  async run(context) {
    const time = manualClock(0);
    const leases = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemoryAgentRunStore({ clock: time.clock });
    const broken: LeaseProvider = {
      ...leases,
      renew: async () => {
        context.interrupt('lease-renew-failure');
        throw new Error('lease provider down');
      },
    };
    const { model, calls } = scripted([{ text: 'Done.' }]);
    const options = {
      model,
      messages: context.messages,
      session: { store, runId: 'job', scope: 'eval' },
      deps: { clock: time.clock, observer: context.observer, priceProvider: mockPrices },
    };
    const first = await runAgent({
      ...options,
      lease: { provider: broken, owner: 'a', ttlMs: 300 },
    });
    const untouched = (await store.list()).runs.length === 0 && calls() === 0;
    const next = await runAgent({
      ...options,
      lease: { provider: leases, owner: 'b', ttlMs: 300 },
    });
    context.store.billedCalls = calls();
    return {
      ...next,
      recovery: first.status === 'failed' && untouched ? 'next-executor-runs' : 'other',
    };
  },
};

/** A budget store whose `method` fails once, at the `nth` call, with a serialization failure. */
function failingStore(method: 'reserve' | 'settle', nth: number, onFail: () => void) {
  const inner = createInMemoryBudgetStore();
  let count = 0;
  const store: BudgetStore = {
    ...inner,
    [method]: (...args: unknown[]) => {
      count += 1;
      if (count === nth) {
        onFail();
        return Promise.reject(
          Object.assign(new Error('could not serialize access due to concurrent update'), {
            code: '40001',
          }),
        );
      }
      return (inner[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
  return { store, inner };
}

const scopes = [{ key: 'user:1', limits: { tokens: 1_000_000 } }];

export const admissionStoreFailure: EvalTaskManifest = {
  id: 'fault/admission-store-failure',
  version: 1,
  title: "The budget store's admission fails (40001) before the second model call",
  tags: ['fault', 'native', 'budget'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Archive T-9, then confirm.' }] },
  fault: { boundary: 'admission-store-failure', recovery: 'fail-closed' },
  acceptance: [
    {
      name: 'fails closed with admission_failed',
      check: (outcome) => outcome.status === 'failed' && outcome.error?.code === 'admission_failed',
    },
    ranOnce('archive:T-9'),
    {
      name: 'the store holds exactly the settled first call: no leaked hold',
      check: (_outcome, context) =>
        (context.store.storeUsage as { tokens?: number } | undefined)?.tokens === 15,
    },
    costKept,
  ],
  async run(context) {
    const { store, inner } = failingStore('reserve', 2, () =>
      context.interrupt('admission-store-failure'),
    );
    const effects: string[] = [];
    context.store.effects = effects;
    const { model, calls } = scripted([
      { toolCalls: [{ toolName: 'archive', args: {} }] },
      { text: 'Archived.' },
    ]);
    const runs = createInMemoryAgentRunStore();
    const options = {
      model,
      messages: context.messages,
      session: { store: runs, runId: 'j', scope: 'eval' },
      tools: {
        archive: {
          parameters,
          execute: () => {
            context.effect('archive:T-9');
            effects.push('archive:T-9');
            return 'archived';
          },
        },
      },
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const first = await runAgent({
      ...options,
      execution: createExecutionContext({ scopeId: 'j', admission: { store, scopes } }),
    });
    // The failure is recorded as the run's terminal result: a resume returns it.
    const saved = (await runs.load('j'))!;
    const resumed = await resumeAgent({
      ...options,
      execution: createExecutionContext({ snapshot: saved.execution!, admission: { store } }),
    });
    context.store.storeUsage = await inner.usage('user:1');
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        first.status === 'failed' &&
        calls() === 1 &&
        JSON.stringify(resumed) === JSON.stringify(first)
          ? 'fail-closed'
          : 'other',
    };
  },
};

export const settleFailure: EvalTaskManifest = {
  id: 'fault/settle-failure',
  version: 1,
  title: "The budget store's settlement fails once: the ledger retries it",
  tags: ['fault', 'native', 'budget'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Say hi.' }] },
  fault: { boundary: 'settle-failure', recovery: 'settlement-retried' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    {
      name: 'the hold closed at the actual usage',
      check: (outcome, context) =>
        (context.store.storeUsage as { tokens?: number } | undefined)?.tokens === 15 &&
        outcome.accounting?.reserved.tokens === 0,
    },
    costKept,
  ],
  async run(context) {
    const { store, inner } = failingStore('settle', 1, () => context.interrupt('settle-failure'));
    const { model, calls } = scripted([{ text: 'hi' }]);
    const result = await runAgent({
      model,
      messages: context.messages,
      execution: createExecutionContext({ admission: { store, scopes } }),
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
    context.store.storeUsage = await inner.usage('user:1');
    context.store.billedCalls = calls();
    return {
      ...result,
      recovery: result.status === 'completed' ? 'settlement-retried' : 'other',
    };
  },
};

export const spawnCommitFailure: EvalTaskManifest = {
  id: 'fault/spawn-commit-failure',
  version: 1,
  title: 'A dynamic swarm crashes before the commit that records spawned children',
  tags: ['fault', 'swarm', 'dynamic'],
  model: MOCK,
  fault: { boundary: 'spawn-commit-failure', recovery: 'safe-replay' },
  acceptance: [
    { name: 'the resumed run completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('report:plan/child'),
    {
      name: 'the child was spawned once',
      check: (outcome) =>
        JSON.stringify(outcome.output) ===
        JSON.stringify(['plan:completed', 'plan/child:completed']),
    },
  ],
  async run(context) {
    const inner = createInMemorySwarmStore();
    let crash = true;
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        if (crash && change.spawn?.length) {
          crash = false;
          context.interrupt('spawn-commit-failure');
          throw new Error('crash before the spawn commit');
        }
        return inner.commit(change);
      },
    };
    let plans = 0;
    const options: SwarmOptions = {
      agents: {},
      store,
      dynamic: { maxTasks: 10, maxSpawnDepth: 2 },
      reducers: {
        plan: {
          execute(_results, task) {
            plans += 1;
            task.spawn([{ key: 'child', reducer: 'work' }]);
            return 'planned';
          },
        },
        work: sendReport(context),
      },
    };
    const handle = await createSwarm(options).run({
      scope: 'eval',
      runId: 'spawn',
      // Planning has no external effect, so it may run again.
      tasks: [{ id: 'plan', reducer: 'plan', replay: 'safe' }],
    });
    const crashed = await handle.result.then(
      () => false,
      () => true,
    );
    const outcome = await (await createSwarm(options).resume(handle)).result;
    return {
      status: outcome.run.status === 'completed' ? 'completed' : 'failed',
      output: outcome.tasks.map((task) => `${task.task.id}:${task.status}`),
      recovery: crashed && plans === 2 ? 'safe-replay' : 'other',
    };
  },
};
