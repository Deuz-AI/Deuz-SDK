import { describe, expect, it, vi } from 'vitest';
import { createSwarm, createInMemorySwarmStore } from '../src/swarm';
import type { SwarmOptions, SwarmSnapshot, SwarmStore } from '../src/types/swarm';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition not reached');
}

function interrupted(): SwarmSnapshot {
  return {
    run: {
      kind: 'deuz-swarm',
      version: 1,
      scope: 'tenant-a',
      runId: 'recover',
      definitionVersion: '1',
      status: 'running',
      revision: 0,
      lastSequence: 0,
      createdAt: 1,
      updatedAt: 1,
      cancelRequested: false,
    },
    tasks: [
      {
        task: { id: 'done', reducer: 'sum' },
        bindingVersion: '1',
        status: 'completed',
        attempt: 1,
        result: { output: 5 },
      },
      {
        task: { id: 'interrupted', reducer: 'sum', dependsOn: ['done'] },
        bindingVersion: '1',
        status: 'running',
        attempt: 1,
      },
    ],
  };
}

describe('native swarm scheduler', () => {
  it('executes 1000 logical tasks within the live concurrency bound without event subscribers', async () => {
    let running = 0;
    let highWater = 0;
    let calls = 0;
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      concurrency: 7,
      reducers: {
        work: {
          async execute() {
            running++;
            highWater = Math.max(highWater, running);
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 0));
            running--;
            return 1;
          },
        },
        sum: {
          execute(results) {
            return Object.values(results).reduce((sum, value) => sum + Number(value.output), 0);
          },
        },
      },
    });
    const tasks = Array.from({ length: 1000 }, (_, index) => ({
      id: `task-${index}`,
      reducer: 'work',
    }));
    const handle = await swarm.run({
      scope: 'tenant',
      tasks: [...tasks, { id: 'total', reducer: 'sum', dependsOn: tasks.map((task) => task.id) }],
    });
    const result = await handle.result;
    expect(result.run.status).toBe('completed');
    expect(result.tasks.at(-1)?.result?.output).toBe(1000);
    expect(calls).toBe(1000);
    expect(highWater).toBe(7);
    const events = [];
    for await (const event of handle.events({ afterSequence: 1998 })) events.push(event);
    expect(events[0]?.sequence).toBe(1999);
    expect(events.at(-1)?.type).toBe('run.settled');
  });

  it('keeps completed independent branches and blocks only failed descendants', async () => {
    const executed: string[] = [];
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      reducers: {
        good: {
          execute(_results, context) {
            executed.push(context.taskId);
            return context.taskId;
          },
        },
        bad: {
          execute() {
            throw new Error('failed branch');
          },
        },
      },
    });
    const result = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [
          { id: 'bad', reducer: 'bad' },
          { id: 'blocked', reducer: 'good', dependsOn: ['bad'] },
          { id: 'good', reducer: 'good' },
          { id: 'good-child', reducer: 'good', dependsOn: ['good'] },
        ],
      })
    ).result;
    expect(result.run.status).toBe('partial');
    expect(result.tasks.map((task) => task.status)).toEqual([
      'failed',
      'blocked',
      'completed',
      'completed',
    ]);
    expect(executed).toEqual(['good', 'good-child']);
  });

  it('never repeats interrupted manual work until explicitly authorized', async () => {
    const store = createInMemorySwarmStore();
    await store.create(interrupted(), []);
    const execute = vi.fn((results) => Number(results.done.output) + 1);
    const swarm = createSwarm({ agents: {}, store, reducers: { sum: { execute } } });
    const first = await (await swarm.resume({ scope: 'tenant-a', runId: 'recover' })).result;
    expect(first.run.status).toBe('suspended');
    expect(first.tasks[1]?.status).toBe('needs_reconciliation');
    expect(execute).not.toHaveBeenCalled();
    const recovered = await (
      await swarm.resume({ scope: 'tenant-a', runId: 'recover', retryTaskIds: ['interrupted'] })
    ).result;
    expect(recovered.tasks[0]?.attempt).toBe(1);
    expect(recovered.tasks[1]?.result?.output).toBe(6);
    expect(execute).toHaveBeenCalledOnce();
    await expect(swarm.resume({ scope: 'tenant-b', runId: 'recover' })).rejects.toThrow(
      'not found',
    );
  });

  it('persists cancellation, stops admission, and preserves settled results', async () => {
    const started = gate();
    let calls = 0;
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      concurrency: 1,
      reducers: {
        work: {
          async execute(_results, context) {
            calls++;
            started.resolve();
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            return 'late';
          },
        },
      },
    });
    const handle = await swarm.run({
      scope: 'tenant',
      tasks: [
        { id: 'a', reducer: 'work' },
        { id: 'b', reducer: 'work' },
      ],
    });
    await started.promise;
    await handle.cancel();
    const result = await handle.result;
    expect(calls).toBe(1);
    expect(result.run.status).toBe('cancelled');
    expect(result.tasks.every((task) => task.status === 'cancelled')).toBe(true);
  });

  it('rejects cycles and unknown bindings before store writes; rejects duplicate executors', async () => {
    const gate1 = gate();
    const store = createInMemorySwarmStore();
    const create = vi.spyOn(store, 'create');
    const options: SwarmOptions = {
      agents: {},
      store,
      reducers: {
        work: {
          async execute() {
            await gate1.promise;
            return 1;
          },
        },
      },
    };
    const swarm = createSwarm(options);
    await expect(
      swarm.run({
        scope: 'x',
        tasks: [
          { id: 'a', reducer: 'work', dependsOn: ['b'] },
          { id: 'b', reducer: 'work', dependsOn: ['a'] },
        ],
      }),
    ).rejects.toThrow('cycle');
    expect(create).not.toHaveBeenCalled();
    const handle = await swarm.run({
      scope: 'x',
      runId: 'same',
      tasks: [{ id: 'a', reducer: 'work' }],
    });
    await expect(createSwarm(options).resume({ scope: 'x', runId: 'same' })).rejects.toThrow(
      'executor',
    );
    gate1.resolve();
    await handle.result;
  });

  it('stops dispatch when persistence fails and surfaces the failure to result', async () => {
    const inner = createInMemorySwarmStore();
    let effect = 0;
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        if (change.events?.some((event) => event.type === 'task.started'))
          throw new Error('disk unavailable');
        return inner.commit(change);
      },
    };
    const swarm = createSwarm({
      agents: {},
      store,
      concurrency: 1,
      reducers: {
        work: {
          execute() {
            effect++;
            return 1;
          },
        },
      },
    });
    const handle = await swarm.run({
      scope: 'tenant',
      tasks: [
        { id: 'a', reducer: 'work' },
        { id: 'b', reducer: 'work' },
      ],
    });
    await expect(handle.result).rejects.toThrow('disk unavailable');
    expect(effect).toBe(0);
  });

  it('lets cursor consumers disconnect without cancelling producers', async () => {
    const release = gate();
    let started = false;
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      reducers: {
        work: {
          async execute() {
            started = true;
            await release.promise;
            return 42;
          },
        },
      },
    });
    const handle = await swarm.run({ scope: 'tenant', tasks: [{ id: 'a', reducer: 'work' }] });
    await until(() => started);
    for await (const event of handle.events()) {
      expect(event.sequence).toBe(1);
      break;
    }
    release.resolve();
    expect((await handle.result).tasks[0]?.result?.output).toBe(42);
  });

  it('durably accounts concurrent sibling reservations and retains unknown spend on recovery', async () => {
    const store = createInMemorySwarmStore();
    const swarm = createSwarm({
      agents: {},
      store,
      budget: { tokens: 10 },
      concurrency: 3,
      reducers: {
        work: {
          async execute(_results, context) {
            await context.execution.reserve({
              requestId: context.taskId,
              modelId: 'test',
              tokens: 6,
            });
            await context.execution.ledger.markUnknown(context.taskId);
            return 'possibly billed';
          },
        },
      },
    });
    const first = await (
      await swarm.run({
        scope: 'tenant',
        runId: 'budget',
        tasks: [
          { id: 'a', reducer: 'work' },
          { id: 'b', reducer: 'work' },
          { id: 'c', reducer: 'work' },
        ],
      })
    ).result;
    expect(first.tasks.filter((task) => task.status === 'completed')).toHaveLength(1);
    expect(first.run.executionState?.ledger.reservations).toHaveLength(1);
    expect(first.run.executionState?.ledger.reservations[0]?.state).toBe('unknown');
    const reopened = createSwarm({
      agents: {},
      store,
      budget: { tokens: 1000 },
      reducers: {
        work: {
          execute() {
            throw new Error('must not repeat');
          },
        },
      },
    });
    const recovered = await (await reopened.resume(first.run)).result;
    expect(recovered.run.executionState?.budget.tokens).toBe(10);
    expect(recovered.run.executionState?.ledger.reservations[0]?.state).toBe('unknown');
  });

  it('does not relax persisted policy when a process restarts with weaker defaults', async () => {
    const store = createInMemorySwarmStore();
    const snapshot = interrupted();
    const { createExecutionContext } = await import('../src/execution-policy');
    snapshot.run.executionState = createExecutionContext({
      policy: { allowedTools: ['read'], requireApproval: true },
      scopeId: 'policy',
    }).snapshot();
    snapshot.tasks[1]!.task.replay = 'safe';
    await store.create(snapshot, []);
    const swarm = createSwarm({
      agents: {},
      store,
      policy: { allowedTools: ['read', 'write'], requireApproval: false },
      reducers: {
        sum: {
          execute(_results, context) {
            return context.execution.policy;
          },
        },
      },
    });
    const recovered = await (await swarm.resume(snapshot.run)).result;
    expect(recovered.tasks[1]?.result?.output).toMatchObject({
      allowedTools: ['read'],
      requireApproval: true,
    });
  });
});
