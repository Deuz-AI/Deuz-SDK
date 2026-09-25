import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent';
import { createMockModel } from '../src/testing';
import { createInMemorySwarmStore, createRounds, createSwarm } from '../src/swarm';
import type { RoundsConsolidateInput, SwarmReducerBinding } from '../src/swarm';

describe('soft dependencies: after (2.2)', () => {
  it('runs after settled tasks whatever their outcome and reports their statuses', async () => {
    const swarm = createSwarm({
      agents: {},
      store: createInMemorySwarmStore(),
      reducers: {
        ok: { execute: () => 'fine' },
        boom: {
          execute() {
            throw new Error('explorer failed');
          },
        },
        gather: {
          execute: (results, context) => ({
            results: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.output])),
            settled: context.settled,
          }),
        },
        strict: { execute: () => 'must not run' },
      },
    });
    const outcome = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [
          { id: 'a', reducer: 'ok' },
          { id: 'b', reducer: 'boom' },
          { id: 'join', reducer: 'gather', after: ['a', 'b'] },
          { id: 'hard', reducer: 'strict', dependsOn: ['b'] },
        ],
      })
    ).result;
    expect(outcome.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['a', 'completed'],
      ['b', 'failed'],
      ['join', 'completed'],
      ['hard', 'blocked'],
    ]);
    expect(outcome.tasks[2]?.result?.output).toEqual({
      results: { a: 'fine' },
      settled: { a: 'completed', b: 'failed' },
    });
  });

  it('rejects unknown or cyclic soft dependencies before anything is written', async () => {
    const store = createInMemorySwarmStore();
    const create = vi.spyOn(store, 'create');
    const swarm = createSwarm({ agents: {}, store, reducers: { ok: { execute: () => 1 } } });
    await expect(
      swarm.run({ scope: 'tenant', tasks: [{ id: 'a', reducer: 'ok', after: ['nope'] }] }),
    ).rejects.toThrow(/Missing dependency/);
    await expect(
      swarm.run({
        scope: 'tenant',
        tasks: [
          { id: 'a', reducer: 'ok', after: ['b'] },
          { id: 'b', reducer: 'ok', dependsOn: ['a'] },
        ],
      }),
    ).rejects.toThrow(/cycle/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('createRounds (2.2)', () => {
  const echoPrompt: SwarmReducerBinding = { execute: () => 'unused' };

  it('runs the Navier–Stokes pattern: solve, consolidate, reallocate, stop', async () => {
    const solver = createAgent({
      model: createMockModel({
        responses: [
          { text: 'Euler blows up at t=1' },
          { text: 'NS attempt A' },
          { text: 'NS attempt B' },
        ],
      }),
    });
    const seen: RoundsConsolidateInput[] = [];
    const rounds = createRounds({
      id: 'search',
      maxRounds: 3,
      initial: { euler: { agent: 'solver', count: 1, prompt: 'Solve the easier Euler case.' } },
      consolidate(input) {
        seen.push(input);
        if (input.round === 1) {
          const insight = String(input.groups.euler?.[0]?.output);
          return {
            groups: {
              ns: { agent: 'solver', count: 2, prompt: `Attack Navier–Stokes using: ${insight}` },
            },
          };
        }
        return { stop: true, summary: input.groups.ns?.map((result) => result.output) };
      },
    });
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      concurrency: 1,
      dynamic: { maxTasks: 50, maxSpawnDepth: 4 },
      agents: { solver },
      reducers: { ...rounds.reducers, unused: echoPrompt },
    });
    const outcome = await (await swarm.run({ scope: 'lab', tasks: rounds.tasks })).result;
    expect(outcome.run.status).toBe('completed');
    expect(outcome.tasks.map((task) => task.task.id)).toEqual([
      'search',
      'search/euler.1',
      'search/c1',
      'search/c1/ns.1',
      'search/c1/ns.2',
      'search/c1/c2',
    ]);
    const nsTask = outcome.tasks[3]!.task;
    expect(nsTask.agent !== undefined && nsTask.prompt).toBe(
      'Attack Navier–Stokes using: Euler blows up at t=1',
    );
    expect(nsTask.group).toBe('ns');
    expect(seen.map((input) => input.round)).toEqual([1, 2]);
    expect(outcome.tasks.at(-1)?.result?.output).toEqual({
      round: 2,
      stopped: true,
      summary: ['NS attempt A', 'NS attempt B'],
    });
  });

  it('keeps consolidating when an explorer fails', async () => {
    const solver = createAgent({
      model: createMockModel({ responses: [{ text: 'good' }, { text: 'bad' }] }),
    });
    const rounds = createRounds({
      id: 'r',
      maxRounds: 1,
      initial: { g: { agent: 'solver', count: 2, prompt: 'Explore.' } },
      consolidate: (input) => ({ stop: true, summary: input.groups.g?.length ?? 0 }),
    });
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      concurrency: 1,
      dynamic: { maxTasks: 10, maxSpawnDepth: 2 },
      agents: {
        solver: {
          agent: solver,
          verify: ({ output }) =>
            output === 'bad' ? { status: 'inconclusive' } : { status: 'verified' },
        },
      },
      reducers: rounds.reducers,
    });
    const outcome = await (await swarm.run({ scope: 'lab', tasks: rounds.tasks })).result;
    expect(outcome.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['r', 'completed'],
      ['r/g.1', 'completed'],
      ['r/g.2', 'failed'],
      ['r/c1', 'completed'],
    ]);
    expect(outcome.tasks.at(-1)?.result?.output).toEqual({ round: 1, stopped: true, summary: 1 });
  });

  it('stops at maxRounds and refuses agents outside the allowlist', async () => {
    const solver = createAgent({
      model: createMockModel({ responses: Array.from({ length: 5 }, () => ({ text: 'x' })) }),
    });
    const endless = createRounds({
      id: 'loop',
      maxRounds: 2,
      initial: { g: { agent: 'solver', count: 1, prompt: 'Go.' } },
      consolidate: () => ({ groups: { g: { agent: 'solver', count: 1, prompt: 'Again.' } } }),
    });
    const rogue = createRounds({
      id: 'rogue',
      maxRounds: 3,
      initial: { g: { agent: 'solver', count: 1, prompt: 'Go.' } },
      consolidate: () => ({ groups: { g: { agent: 'admin', count: 1, prompt: 'Escalate.' } } }),
    });
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      concurrency: 1,
      dynamic: { maxTasks: 20, maxSpawnDepth: 5 },
      agents: { solver, admin: solver },
      reducers: { ...endless.reducers, ...rogue.reducers },
    });
    const looped = await (await swarm.run({ scope: 'lab', tasks: endless.tasks })).result;
    expect(looped.tasks.at(-1)).toMatchObject({
      task: { id: 'loop/c1/c2' },
      result: { output: { round: 2, stopped: true } },
    });
    const refused = await (await swarm.run({ scope: 'lab', tasks: rogue.tasks })).result;
    expect(refused.tasks.at(-1)).toMatchObject({
      task: { id: 'rogue/c1' },
      status: 'failed',
      error: { message: expect.stringMatching(/not allowed/) },
    });
  });

  it('validates its options up front', () => {
    const base = {
      id: 'x',
      maxRounds: 1,
      initial: { g: { agent: 'a', count: 1, prompt: 'p' } },
      consolidate: () => ({ stop: true }),
    };
    expect(() => createRounds({ ...base, maxRounds: 0 })).toThrow(/maxRounds/);
    expect(() => createRounds({ ...base, initial: {} })).toThrow(/group/);
    expect(() =>
      createRounds({ ...base, initial: { 'bad-group': { agent: 'a', count: 1, prompt: 'p' } } }),
    ).toThrow(/group/);
    expect(() =>
      createRounds({ ...base, initial: { g: { agent: 'a', count: 0, prompt: 'p' } } }),
    ).toThrow(/count/);
  });
});
