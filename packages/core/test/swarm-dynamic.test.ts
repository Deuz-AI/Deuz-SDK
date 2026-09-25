import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent';
import { createMockModel } from '../src/testing';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import type {
  SwarmOptions,
  SwarmReducerBinding,
  SwarmSnapshot,
  SwarmStore,
} from '../src/types/swarm';

const limits = { maxTasks: 20, maxSpawnDepth: 2 };
const echo: SwarmReducerBinding = { execute: (_results, context) => context.taskId };

async function events(swarm: ReturnType<typeof createSwarm>, key: SwarmSnapshot['run']) {
  const seen: { type: string; taskId?: string; detail?: string }[] = [];
  for await (const event of swarm.events(key))
    seen.push({ type: event.type, taskId: event.taskId, detail: event.detail });
  return seen;
}

describe('dynamic swarm spawning (2.2)', () => {
  it('lets a reducer fan out at runtime and a spawned join collect the work', async () => {
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      dynamic: limits,
      reducers: {
        plan: {
          execute(_results, context) {
            context.spawn([
              { key: 'a', reducer: 'work' },
              { key: 'b', reducer: 'work' },
              {
                key: 'join',
                reducer: 'join',
                dependsOn: [`${context.taskId}/a`, `${context.taskId}/b`],
              },
            ]);
            return 'planned';
          },
        },
        work: echo,
        join: { execute: (results) => Object.keys(results).sort() },
      },
    });
    const outcome = await (
      await swarm.run({ scope: 'tenant', runId: 'fan', tasks: [{ id: 'plan', reducer: 'plan' }] })
    ).result;
    expect(outcome.run).toMatchObject({ status: 'completed', version: 2 });
    expect(outcome.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['plan', 'completed'],
      ['plan/a', 'completed'],
      ['plan/b', 'completed'],
      ['plan/join', 'completed'],
    ]);
    expect(outcome.tasks[3]?.result?.output).toEqual(['plan/a', 'plan/b']);
    expect(outcome.tasks[1]).toMatchObject({
      depth: 1,
      spawnedBy: { taskId: 'plan', attempt: 1, on: 'completed' },
    });
    const spawned = (await events(swarm, outcome.run)).filter((e) => e.type === 'task.spawned');
    expect(spawned).toEqual([
      { type: 'task.spawned', taskId: 'plan/a', detail: 'plan' },
      { type: 'task.spawned', taskId: 'plan/b', detail: 'plan' },
      { type: 'task.spawned', taskId: 'plan/join', detail: 'plan' },
    ]);
  });

  it('lets an agent binding spawn tasks from its validated output', async () => {
    const schema = {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' } } },
      required: ['steps'],
    };
    const planner = createAgent({
      model: createMockModel({ responses: [{ text: '{"steps":["x","y"]}' }] }),
    });
    const worker = createAgent({
      model: createMockModel({ responses: [{ text: 'x done' }, { text: 'y done' }] }),
    });
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      dynamic: limits,
      agents: {
        planner: {
          agent: planner,
          output: {
            schema,
            mode: 'json',
            validate: (value) => value as { steps: string[] },
          },
          spawn: (output) =>
            (output as { steps: string[] }).steps.map((step) => ({
              key: step,
              agent: 'worker',
              prompt: `Do ${step}.`,
            })),
        },
        worker,
      },
    });
    const outcome = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [{ id: 'plan', agent: 'planner', prompt: 'Plan two steps.' }],
      })
    ).result;
    expect(outcome.run.status).toBe('completed');
    expect(outcome.tasks.map((task) => task.task.id)).toEqual(['plan', 'plan/x', 'plan/y']);
    expect(outcome.tasks.slice(1).map((task) => task.result?.output)).toEqual(['x done', 'y done']);
  });

  it.each([
    ['a key with a slash', [{ key: 'a/b', reducer: 'work' }], /spawn key/],
    ['an unknown binding', [{ key: 'a', reducer: 'missing' }], /Unknown reducer/],
    ['a missing dependency', [{ key: 'a', reducer: 'work', dependsOn: ['nope'] }], /nope/],
    [
      'a repeated key',
      [
        { key: 'a', reducer: 'work' },
        { key: 'a', reducer: 'work' },
      ],
      /not new/,
    ],
  ])('fails the spawning task on %s and creates nothing', async (_label, requests, message) => {
    const onFailure = vi.fn(() => []);
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      dynamic: limits,
      reducers: {
        plan: {
          execute(_results, context) {
            context.spawn(requests as never);
            return 'planned';
          },
          onFailure,
        },
        work: echo,
      },
    });
    const outcome = await (
      await swarm.run({ scope: 'tenant', tasks: [{ id: 'plan', reducer: 'plan' }] })
    ).result;
    expect(outcome.tasks).toHaveLength(1);
    expect(outcome.tasks[0]).toMatchObject({ status: 'failed', error: { message: message } });
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('fails a spawning task that would exceed maxTasks or maxSpawnDepth', async () => {
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      dynamic: { maxTasks: 3, maxSpawnDepth: 1 },
      reducers: {
        wide: {
          execute(_results, context) {
            context.spawn(['1', '2', '3'].map((key) => ({ key, reducer: 'leaf' })));
            return 'wide';
          },
        },
        deep: {
          execute(_results, context) {
            context.spawn([{ key: 'child', reducer: 'deep' }]);
            return 'deep';
          },
        },
        leaf: echo,
      },
    });
    const wide = await (
      await swarm.run({ scope: 'tenant', tasks: [{ id: 'w', reducer: 'wide' }] })
    ).result;
    expect(wide.tasks).toHaveLength(1);
    expect(wide.tasks[0]).toMatchObject({ status: 'failed', error: { message: /task limit/ } });
    const deep = await (
      await swarm.run({ scope: 'tenant', tasks: [{ id: 'd', reducer: 'deep' }] })
    ).result;
    expect(deep.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['d', 'completed'],
      ['d/child', 'failed'],
    ]);
    expect(deep.tasks[1]?.error?.message).toMatch(/depth/);
  });

  it('replays a parent that crashed before its spawn commit without duplicating children', async () => {
    const inner = createInMemorySwarmStore();
    let crash = true;
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        if (crash && change.spawn?.length) throw new Error('crash before the spawn commit');
        return inner.commit(change);
      },
    };
    const plan = vi.fn((_results: unknown, context: { spawn: (r: never) => void }) => {
      context.spawn([{ key: 'child', reducer: 'work' }] as never);
      return 'planned';
    });
    const options: SwarmOptions = {
      agents: {},
      store,
      dynamic: limits,
      reducers: { plan: { execute: plan as never }, work: echo },
    };
    const handle = await createSwarm(options).run({
      scope: 'tenant',
      runId: 'crash-before',
      tasks: [{ id: 'plan', reducer: 'plan' }],
    });
    await expect(handle.result).rejects.toThrow('crash before the spawn commit');
    crash = false;
    const recovered = await (
      await createSwarm(options).resume({ ...handle, retryTaskIds: ['plan'] })
    ).result;
    expect(recovered.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['plan', 'completed'],
      ['plan/child', 'completed'],
    ]);
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('resumes spawned children after a crash without re-running their parent', async () => {
    const inner = createInMemorySwarmStore();
    let crash = true;
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        if (
          crash &&
          change.events?.some((e) => e.type === 'task.started' && e.taskId === 'plan/child')
        )
          throw new Error('crash after the spawn commit');
        return inner.commit(change);
      },
    };
    const plan = vi.fn((_results: unknown, context: { spawn: (r: never) => void }) => {
      context.spawn([{ key: 'child', reducer: 'work' }] as never);
      return 'planned';
    });
    const options: SwarmOptions = {
      agents: {},
      store,
      dynamic: limits,
      reducers: { plan: { execute: plan as never }, work: echo },
    };
    const handle = await createSwarm(options).run({
      scope: 'tenant',
      runId: 'crash-after',
      tasks: [{ id: 'plan', reducer: 'plan' }],
    });
    await expect(handle.result).rejects.toThrow('crash after the spawn commit');
    crash = false;
    const recovered = await (await createSwarm(options).resume(handle)).result;
    expect(recovered.run.status).toBe('completed');
    expect(recovered.tasks[1]?.result?.output).toBe('plan/child');
    expect(plan).toHaveBeenCalledOnce();
  });

  it('commits compensation tasks with the failed state and records a failing hook', async () => {
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      dynamic: limits,
      reducers: {
        risky: {
          execute() {
            throw new Error('charge failed');
          },
          onFailure: (context) => [
            { key: 'refund', reducer: 'refund', timeoutMs: undefined },
            ...(context.error.message === 'charge failed' ? [] : []),
          ],
        },
        broken: {
          execute() {
            throw new Error('write failed');
          },
          onFailure: () => {
            throw new Error('no undo');
          },
        },
        refund: echo,
      },
    });
    const outcome = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [
          { id: 'charge', reducer: 'risky' },
          { id: 'write', reducer: 'broken' },
        ],
      })
    ).result;
    expect(outcome.run.status).toBe('partial');
    expect(outcome.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['charge', 'failed'],
      ['write', 'failed'],
      ['charge/refund', 'completed'],
    ]);
    expect(outcome.tasks[2]).toMatchObject({ spawnedBy: { taskId: 'charge', on: 'failed' } });
    expect(outcome.tasks[1]?.error?.message).toBe('write failed (compensation failed: no undo)');
  });

  it('refuses to spawn from a run created without dynamic limits', async () => {
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      reducers: {
        plan: {
          execute(_results, context) {
            context.spawn([{ key: 'a', reducer: 'plan' }]);
            return 'planned';
          },
        },
      },
    });
    const outcome = await (
      await swarm.run({ scope: 'tenant', tasks: [{ id: 'plan', reducer: 'plan' }] })
    ).result;
    expect(outcome.run.version).toBe(1);
    expect(outcome.tasks).toHaveLength(1);
    expect(outcome.tasks[0]?.error?.message).toMatch(/without `dynamic`/);
  });

  it('refuses a dynamic swarm on a store without the spawn capability', () => {
    const { capabilities: _capabilities, ...plain } = createInMemorySwarmStore();
    expect(() => createSwarm({ agents: {}, store: plain, dynamic: limits })).toThrow(/spawn/);
    expect(() =>
      createSwarm({
        agents: {},
        store: createInMemorySwarmStore(),
        dynamic: { maxTasks: 0, maxSpawnDepth: 1 },
      }),
    ).toThrow(/maxTasks/);
  });

  it('revalidates spawned bindings on resume and never loosens the persisted limits', async () => {
    const store = createInMemorySwarmStore();
    const reducers = {
      plan: {
        execute(_results: unknown, context: { spawn: (r: never) => void }) {
          context.spawn([{ key: 'a', reducer: 'work' }] as never);
          return 'planned';
        },
      },
      work: echo,
    } as unknown as SwarmOptions['reducers'];
    const first = await (
      await createSwarm({
        agents: {},
        store,
        dynamic: { maxTasks: 2, maxSpawnDepth: 1 },
        reducers,
      }).run({
        scope: 'tenant',
        runId: 'limits',
        tasks: [{ id: 'plan', reducer: 'plan' }],
      })
    ).result;
    expect(first.run.dynamic).toEqual({ maxTasks: 2, maxSpawnDepth: 1, maxSpawnPerTask: 2 });
    await expect(
      createSwarm({
        agents: {},
        store,
        dynamic: limits,
        reducers: { plan: reducers!.plan! },
      }).resume(first.run),
    ).rejects.toThrow(/Unknown reducer/);
    const reopened = await (
      await createSwarm({
        agents: {},
        store,
        dynamic: { maxTasks: 100, maxSpawnDepth: 9 },
        reducers,
      }).resume(first.run)
    ).result;
    expect(reopened.run.dynamic).toEqual({ maxTasks: 2, maxSpawnDepth: 1, maxSpawnPerTask: 2 });
  });
});

describe('per-task timeoutMs (2.2)', () => {
  function recordingClock() {
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    return {
      timers,
      clock: {
        now: () => 1_000,
        setTimeout: (fn: () => void, ms: number) => {
          const timer = { ms, fn, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      },
    };
  }
  async function until(predicate: () => boolean) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Condition not reached');
  }

  it('fails an attempt that outlives its budget, aborts its signal and clears finished timers', async () => {
    const { timers, clock } = recordingClock();
    let signal: AbortSignal | undefined;
    let deadline: number | undefined;
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      deps: { clock },
      reducers: {
        slow: {
          execute: (_results, context) =>
            new Promise((resolve) => {
              signal = context.signal;
              deadline = context.execution.policy.deadlineAt;
              context.signal.addEventListener('abort', () => resolve('late'), { once: true });
            }),
        },
        fast: { execute: () => 'quick' },
      },
    });
    const handle = await swarm.run({
      scope: 'tenant',
      tasks: [
        { id: 'fast', reducer: 'fast', timeoutMs: 5_000 },
        { id: 'slow', reducer: 'slow', timeoutMs: 5_000 },
      ],
    });
    await until(() => signal !== undefined && timers.filter((t) => t.cancelled).length === 1);
    expect(deadline).toBe(6_000);
    const live = timers.filter((timer) => timer.ms === 5_000 && !timer.cancelled);
    expect(live).toHaveLength(1);
    live[0]!.fn();
    const outcome = await handle.result;
    expect(signal?.aborted).toBe(true);
    expect(outcome.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['fast', 'completed'],
      ['slow', 'failed'],
    ]);
    expect(outcome.tasks[1]?.error).toMatchObject({
      name: 'SwarmTaskTimeout',
      message: expect.stringContaining('5000ms'),
    });
    expect(timers.every((timer) => timer.cancelled)).toBe(true);
  });

  it("gives an agent task's execution context the attempt deadline", async () => {
    const { clock } = recordingClock();
    let deadline: number | undefined;
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      deps: { clock },
      agents: {
        worker: {
          agent: createAgent({ model: createMockModel({ responses: [{ text: 'done' }] }) }),
          verify: (context) => {
            deadline = context.execution.policy.deadlineAt;
            return { status: 'verified' };
          },
        },
      },
    });
    const outcome = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [{ id: 'a', agent: 'worker', prompt: 'go', timeoutMs: 2_500 }],
      })
    ).result;
    expect(outcome.tasks[0]?.status).toBe('completed');
    expect(deadline).toBe(3_500);
  });

  it.each([0, -1, 1.5])('rejects timeoutMs %s before anything is written', async (timeoutMs) => {
    const store = createInMemorySwarmStore();
    const create = vi.spyOn(store, 'create');
    const swarm = createSwarm({ agents: {}, store, reducers: { work: echo } });
    await expect(
      swarm.run({ scope: 'tenant', tasks: [{ id: 'a', reducer: 'work', timeoutMs }] }),
    ).rejects.toThrow(/timeoutMs/);
    expect(create).not.toHaveBeenCalled();
  });
});
