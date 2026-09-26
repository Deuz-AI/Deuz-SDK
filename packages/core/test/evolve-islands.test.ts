import { describe, expect, it } from 'vitest';
import { evolve } from '../src/evolve/controller';
import { createInMemoryPopulationStore } from '../src/evolve/store';
import { createMockModel } from '../src/testing';
import type { EvolveEvent, EvolveOptions, EvolveStage } from '../src/evolve/types';

const initial = 'def f(x):\n    # EVOLVE-BLOCK-START\n    return x\n    # EVOLVE-BLOCK-END\n';
const GROW = '<<<<<<< SEARCH\n    return x\n=======\n    x = x + 1\n    return x\n>>>>>>> REPLACE';
const MISS = '<<<<<<< SEARCH\n    return nothing\n=======\n    return 0\n>>>>>>> REPLACE';
const increments = (program: string) => program.split('x = x + 1').length - 1;
const count: EvolveStage = { evaluate: (program) => ({ score: increments(program) }) };
const key = { scope: 'tenant', runId: 'run' };

function options(overrides: Partial<EvolveOptions> = {}): EvolveOptions {
  return {
    ...key,
    initial,
    stages: [count],
    models: [{ model: createMockModel({ responses: [{ text: GROW }] }) }],
    store: createInMemoryPopulationStore(),
    generations: 1,
    mutationsPerGeneration: 2,
    selection: 'beam',
    patch: { diff: 1 },
    budget: { tokens: 1_000_000 },
    seed: 'islands',
    ...overrides,
  };
}

async function collect(events: AsyncIterable<EvolveEvent>): Promise<EvolveEvent[]> {
  const out: EvolveEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('evolve: islands', () => {
  it('deals slots round-robin over islands and migrates along the ring', async () => {
    const handle = evolve(
      options({ islands: { count: 2, migrationEvery: 1, migrationRate: 0.5 } }),
    );
    const result = await handle.result;
    const events = await collect(handle.events());
    expect(result.run.islands[0]!.members).toContain('g1-i0-s0');
    expect(result.run.islands[1]!.members).toContain('g1-i1-s0');
    const migrations = events.filter((event) => event.type === 'migration');
    expect(migrations).toEqual([
      { type: 'migration', generation: 1, from: 1, to: 0, ids: ['g1-i1-s0'] },
      { type: 'migration', generation: 1, from: 0, to: 1, ids: ['g1-i0-s0'] },
    ]);
    expect(result.run.islands[1]!.members).toContain('g1-i0-s0');
  });

  it('does not migrate between migration generations', async () => {
    const handle = evolve(
      options({ islands: { count: 2, migrationEvery: 5, migrationRate: 0.5 } }),
    );
    await handle.result;
    expect((await collect(handle.events())).some((event) => event.type === 'migration')).toBe(
      false,
    );
  });

  it('resets the weakest island to the global best', async () => {
    const biased: EvolveStage = {
      evaluate: (program, context) => ({
        score: increments(program) + (context.island === 0 ? 10 : 0),
      }),
    };
    const store = createInMemoryPopulationStore();
    const handle = evolve(
      options({
        store,
        stages: [biased],
        generations: 2,
        islands: { count: 2, migrationEvery: 100, migrationRate: 0.5, resetWeakestEvery: 1 },
      }),
    );
    const result = await handle.result;
    const resets = (await collect(handle.events())).filter(
      (event) => event.type === 'island.reset',
    );
    expect(resets[0]).toEqual({
      type: 'island.reset',
      generation: 1,
      island: 1,
      seedId: 'g1-i0-s0',
    });
    const [child] = await store.listCandidates(key, { ids: ['g2-i1-s0'] });
    expect(child!.parentId).toBe('g1-i0-s0');
    expect(result.best?.score).toBe(12);
  });

  it('crosses two parents when the population allows it', async () => {
    const crossed = initial.replace('    return x', '    x = x + 1\n    x = x + 1\n    return x');
    const text = '```python\n' + crossed + '```\n' + GROW;
    const store = createInMemoryPopulationStore();
    await evolve(
      options({
        store,
        models: [{ model: createMockModel({ responses: [{ text }] }) }],
        patch: { cross: 1 },
        generations: 2,
        mutationsPerGeneration: 1,
      }),
    ).result;
    const [first, second] = await store.listCandidates(key, { ids: ['g1-i0-s0', 'g2-i0-s0'] });
    // A lone seed has no partner, so generation 1 falls back to a diff.
    expect(first).toMatchObject({ patchType: 'diff', score: 1 });
    expect(second).toMatchObject({ patchType: 'cross', score: 2 });
    expect(new Set([second!.parentId, second!.secondParentId])).toEqual(
      new Set(['g0-i0-s0', 'g1-i0-s0']),
    );
  });

  it('keeps a sibling with the same program out of the population', async () => {
    const result = await evolve(options()).result;
    // Both children of the lone seed are identical; only the first joins.
    expect(result.run.islands[0]!.members).toEqual(['g1-i0-s0', 'g0-i0-s0']);
  });
});

describe('evolve: UCB1 model ensemble', () => {
  it('learns to prefer the model whose mutations improve', async () => {
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        models: [
          { model: createMockModel({ responses: [{ text: GROW }] }) },
          { model: createMockModel({ responses: [{ text: MISS }] }) },
        ],
        generations: 4,
      }),
    ).result;
    const children = (await store.listCandidates(key)).filter((item) => item.generation > 0);
    // Generation 1 tries both arms once.
    expect(children.slice(0, 2).map((item) => item.model)).toEqual([0, 1]);
    const { pulls, rewards } = result.run.bandit;
    expect(pulls[0]! + pulls[1]!).toBe(8);
    expect(pulls[0]!).toBeGreaterThan(pulls[1]!);
    expect(rewards[1]).toBe(0);
    expect(rewards[0]!).toBeGreaterThan(0);
  });

  it('a zero-weight model is never called', async () => {
    const store = createInMemoryPopulationStore();
    await evolve(
      options({
        store,
        models: [
          { model: createMockModel({ responses: [{ text: MISS }] }), weight: 0 },
          { model: createMockModel({ responses: [{ text: GROW }] }) },
        ],
      }),
    ).result;
    const children = (await store.listCandidates(key)).filter((item) => item.generation > 0);
    expect(children.map((item) => item.model)).toEqual([1, 1]);
  });
});

describe('evolve: novelty', () => {
  it('rejects near-duplicates by embedding cosine and stores the embedding', async () => {
    let embedded = 0;
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        novelty: {
          embed: async (texts) => {
            embedded += texts.length;
            return texts.map(() => [1, 0]);
          },
        },
      }),
    ).result;
    const children = await store.listCandidates(key, { generation: 1 });
    expect(children.map((item) => item.rejection?.kind)).toEqual(['novelty', 'novelty']);
    expect(children[0]!.rejection!.message).toMatch(/g0-i0-s0/);
    expect(children[0]!.embedding).toEqual([1, 0]);
    expect((await store.listCandidates(key, { ids: ['g0-i0-s0'] }))[0]!.embedding).toEqual([1, 0]);
    // The seed plus one per child; members reuse their stored embedding.
    expect(embedded).toBe(3);
    expect(result.best?.id).toBe('g0-i0-s0');
  });

  it('keeps distinct programs and lets a judge overrule a near-duplicate', async () => {
    const seen: string[] = [];
    const store = createInMemoryPopulationStore();
    await evolve(
      options({
        store,
        novelty: {
          embed: async (texts) => texts.map(() => [1, 0]),
          maxCosine: 0.99,
          judge: ({ similar }) => {
            seen.push(similar.id);
            return true;
          },
        },
      }),
    ).result;
    expect(seen).toEqual(['g0-i0-s0', 'g0-i0-s0']);
    const children = await store.listCandidates(key, { generation: 1 });
    expect(children.every((item) => item.accepted)).toBe(true);

    const distinct = createInMemoryPopulationStore();
    await evolve(
      options({
        store: distinct,
        novelty: { embed: async (texts) => texts.map((text) => [increments(text), 1]) },
      }),
    ).result;
    expect((await distinct.listCandidates(key, { generation: 1 }))[0]!.accepted).toBe(true);
  });
});
