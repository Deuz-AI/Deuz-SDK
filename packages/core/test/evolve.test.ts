import { describe, expect, it } from 'vitest';
import { evolve, resumeEvolve } from '../src/evolve/controller';
import { createInMemoryPopulationStore } from '../src/evolve/store';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { LanguageModel } from '../src/types/model';
import type {
  EvolveCandidate,
  EvolveEvent,
  EvolveOptions,
  EvolveStage,
  PopulationStore,
} from '../src/evolve/types';

const initial = [
  'def f(x):',
  '    # EVOLVE-BLOCK-START',
  '    return x',
  '    # EVOLVE-BLOCK-END',
  '',
].join('\n');

/** Every application adds one increment line, so the score counts successful mutations. */
const GROW = '<<<<<<< SEARCH\n    return x\n=======\n    x = x + 1\n    return x\n>>>>>>> REPLACE';
const MISS = '<<<<<<< SEARCH\n    return nothing\n=======\n    return 0\n>>>>>>> REPLACE';

const increments = (program: string) => program.split('x = x + 1').length - 1;
const countStage: EvolveStage = {
  name: 'count',
  evaluate: (program) => ({ score: increments(program) }),
};

interface Counter {
  calls: number;
  prompts: string[];
}

/** A mock model whose provider fetch is counted — the zero-call resume proof. */
function counted(model: LanguageModel): { model: LanguageModel; counter: Counter } {
  const config = readConfig(model)!;
  const counter: Counter = { calls: 0, prompts: [] };
  const wrapped = attachConfig(
    { ...model },
    {
      ...config,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        counter.calls++;
        counter.prompts.push(String(init?.body));
        return config.fetch!(input, init);
      }) as typeof fetch,
    },
  );
  return { model: wrapped, counter };
}

function grower(text = GROW) {
  return counted(createMockModel({ responses: [{ text }] }));
}

let ids = 0;
const deps = {
  clock: {
    now: () => 1_000,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  },
  generateId: () => `id-${++ids}`,
};

function options(overrides: Partial<EvolveOptions> = {}): EvolveOptions {
  return {
    scope: 'tenant',
    runId: 'run',
    initial,
    stages: [countStage],
    models: [{ model: grower().model }],
    store: createInMemoryPopulationStore(),
    generations: 3,
    mutationsPerGeneration: 2,
    selection: 'beam',
    patch: { diff: 1 },
    budget: { tokens: 1_000_000 },
    seed: 'fixed',
    deps,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<EvolveEvent>): Promise<EvolveEvent[]> {
  const out: EvolveEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const strip = (candidates: EvolveCandidate[]) =>
  candidates.map(
    ({ id, program, parentId, inspirationIds, score, accepted, patchType, model }) => ({
      id,
      program,
      parentId,
      inspirationIds,
      score,
      accepted,
      patchType,
      model,
    }),
  );

describe('evolve: the loop', () => {
  it('evolves over generations with deterministic candidate IDs', async () => {
    const { model, counter } = grower();
    const store = createInMemoryPopulationStore();
    const handle = evolve(options({ models: [{ model }], store }));
    const result = await handle.result;
    expect(result.status).toBe('completed');
    expect(result.reason).toBe('generations');
    expect(result.generation).toBe(3);
    expect(result.best?.score).toBe(3);
    expect(result.modelCalls).toBe(6);
    expect(counter.calls).toBe(6);
    const candidates = await store.listCandidates({ scope: 'tenant', runId: 'run' });
    expect(candidates.map((item) => item.id)).toEqual([
      'g0-i0-s0',
      'g1-i0-s0',
      'g1-i0-s1',
      'g2-i0-s0',
      'g2-i0-s1',
      'g3-i0-s0',
      'g3-i0-s1',
    ]);
    expect(candidates[0]).toMatchObject({ patchType: 'initial', score: 0, accepted: true });
    expect(candidates[3]!.parentId).toMatch(/^g1-/);
    expect(result.run.seed).toBe('fixed');
  });

  it('replays identically for the same seed, and the seed is derived and recorded when omitted', async () => {
    const run = async (seed?: string) => {
      const store = createInMemoryPopulationStore();
      const result = await evolve(
        options({ store, seed, selection: 'weighted', mutationsPerGeneration: 3 }),
      ).result;
      return { result, candidates: await store.listCandidates(result) };
    };
    const a = await run('same');
    const b = await run('same');
    expect(strip(b.candidates)).toEqual(strip(a.candidates));
    const derived = await run(undefined);
    expect(derived.result.seed).toMatch(/^id-/);
  });

  it('streams events and replays them to late iterators', async () => {
    const handle = evolve(options({ generations: 1 }));
    const live = collect(handle.events());
    await handle.result;
    const events = await live;
    expect(events.map((event) => event.type)).toEqual([
      'generation.started',
      'candidate',
      'improvement',
      'generation.committed',
      'generation.started',
      'candidate',
      'candidate',
      'improvement',
      'generation.committed',
      'run.finished',
    ]);
    expect(await collect(handle.events())).toEqual(events);
  });

  it('feeds parent, inspirations and evaluator artifacts into the prompt', async () => {
    const { model, counter } = grower();
    let calls = 0;
    const noisy: EvolveStage = {
      evaluate: (program) => {
        calls++;
        if (calls === 2) throw new Error('Traceback: boom');
        return { score: increments(program), artifacts: { stderr: `warn ${calls}` } };
      },
    };
    const result = await evolve(
      options({ models: [{ model }], stages: [noisy], generations: 2, instructions: 'Grow x.' }),
    ).result;
    expect(result.status).toBe('completed');
    const secondGeneration = counter.prompts.slice(2).join('\n');
    expect(secondGeneration).toContain('Grow x.');
    expect(secondGeneration).toContain('Traceback: boom');
    expect(secondGeneration).toContain('x = x + 1');
  });

  it('records a patch that does not apply as a rejected candidate without evaluating it', async () => {
    let evaluations = 0;
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        models: [{ model: grower(MISS).model }],
        generations: 1,
        stages: [{ evaluate: (program) => (evaluations++, { score: increments(program) }) }],
      }),
    ).result;
    expect(evaluations).toBe(1);
    const children = await store.listCandidates(result, { generation: 1 });
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.accepted).toBe(false);
      expect(child.rejection).toMatchObject({ kind: 'patch' });
      expect(child.rejection!.message).toMatch(/not_found/);
    }
    expect(result.best?.id).toBe('g0-i0-s0');
  });

  it('rejects an unchanged program as a duplicate', async () => {
    const same = '<<<<<<< SEARCH\n    return x\n=======\n    return x\n>>>>>>> REPLACE';
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({ store, models: [{ model: grower(same).model }], generations: 1 }),
    ).result;
    const children = await store.listCandidates(result, { generation: 1 });
    expect(children.map((child) => child.rejection?.kind)).toEqual(['duplicate', 'duplicate']);
  });

  it('applies full rewrites from a fenced block', async () => {
    const rewritten = initial.replace('    return x', '    x = x + 1\n    x = x + 1\n    return x');
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        models: [{ model: grower('```python\n' + rewritten + '```').model }],
        patch: { full: 1 },
        generations: 1,
      }),
    ).result;
    expect(result.best?.score).toBe(2);
    expect(result.best?.patchType).toBe('full');
  });
});

describe('evolve: full rewrites and the final newline', () => {
  // Frozen code that ends without a line break, like a template literal that
  // closes right after its last line.
  const bare = [
    'def f(x):',
    '    # EVOLVE-BLOCK-START',
    '    return x',
    '    # EVOLVE-BLOCK-END',
    'print(f(1))',
  ].join('\n');

  /**
   * Answers like a real model: the current program read back from the prompt,
   * grown by one line, in a fence whose closing line follows a line break. A
   * diff for the same growth follows, for the slots that ask for one.
   */
  function rewriter() {
    const base = createMockModel({ responses: [] });
    const model = attachConfig(
      { ...base },
      {
        ...readConfig(base)!,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { messages } = JSON.parse(String(init?.body)) as {
            messages: { role: string; content: string | { text: string }[] }[];
          };
          const user = messages.find((message) => message.role === 'user')!.content;
          const prompt = typeof user === 'string' ? user : user.map((part) => part.text).join('');
          const section = prompt.slice(prompt.indexOf('## Current program'));
          const start = section.indexOf('```\n') + 4;
          const parent = section.slice(start, section.indexOf('\n```', start));
          const grown = parent.replace('    return x', '    x = x + 1\n    return x');
          const text = '```python\n' + grown + '\n```\n' + GROW;
          return readConfig(createMockModel({ responses: [{ text }] }))!.fetch!(input, init);
        }) as typeof fetch,
      },
    );
    return counted(model);
  }

  it.each([
    ['without', bare],
    ['with', `${bare}\n`],
  ])('accepts full rewrites of a program %s a final newline', async (_label, source) => {
    const { model, counter } = rewriter();
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        initial: source,
        models: [{ model }],
        patch: { full: 1 },
        generations: 2,
        mutationsPerGeneration: 3,
      }),
    ).result;
    expect(counter.calls).toBe(6);
    const children = (await store.listCandidates(result)).filter((item) => item.generation > 0);
    expect(children.filter((item) => item.rejection?.kind === 'patch')).toEqual([]);
    expect(result.best?.score).toBe(2);
    expect(result.best?.program).toBe(
      source.replace('    return x', '    x = x + 1\n    x = x + 1\n    return x'),
    );
    // A rewrite keeps its parent's final newline, or its absence.
    for (const child of children) expect(child.program.endsWith('\n')).toBe(source.endsWith('\n'));
  });

  it.each([
    ['without', bare],
    ['with', `${bare}\n`],
  ])('accepts crossovers of a program %s a final newline', async (_label, source) => {
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        initial: source,
        models: [{ model: rewriter().model }],
        patch: { cross: 1 },
        generations: 2,
        mutationsPerGeneration: 1,
      }),
    ).result;
    const [first, second] = await store.listCandidates(result, {
      ids: ['g1-i0-s0', 'g2-i0-s0'],
    });
    // A lone seed has no partner, so generation 1 falls back to a diff.
    expect(first).toMatchObject({ patchType: 'diff', accepted: true, score: 1 });
    expect(second).toMatchObject({ patchType: 'cross', accepted: true, score: 2 });
    expect(second!.program.endsWith('\n')).toBe(source.endsWith('\n'));
  });

  it('rejects a rewrite that only adds the final newline as a duplicate of its parent', async () => {
    const echo = '```python\n' + bare + '\n```';
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        initial: bare,
        models: [{ model: grower(echo).model }],
        patch: { full: 1 },
        generations: 1,
      }),
    ).result;
    const children = await store.listCandidates(result, { generation: 1 });
    expect(children.map((child) => child.rejection?.kind)).toEqual(['duplicate', 'duplicate']);
  });
});

describe('evolve: evaluation cascade', () => {
  it('stops at the first stage below its threshold and scores by the last evaluated stage', async () => {
    let expensive = 0;
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        generations: 1,
        mutationsPerGeneration: 1,
        stages: [
          { name: 'cheap', evaluate: (program) => ({ score: increments(program) }), threshold: 1 },
          {
            name: 'expensive',
            evaluate: (program) => (
              expensive++,
              { score: 100 + increments(program), metrics: { e: 1 } }
            ),
          },
        ],
      }),
    ).result;
    // The seed (no increments) stops at 'cheap'; its child reaches 'expensive'.
    const all = await store.listCandidates(result);
    expect(all.map((item) => item.stages.map((stage) => stage.name))).toEqual([
      ['cheap'],
      ['cheap', 'expensive'],
    ]);
    expect(expensive).toBe(1);
    expect(all[0]).toMatchObject({
      accepted: false,
      score: 0,
      rejection: { kind: 'cascade', stage: 'cheap' },
    });
    expect(all[1]).toMatchObject({ accepted: true, score: 101, metrics: { e: 1 } });
    expect(result.best?.score).toBe(101);
  });

  it('fails a stage that reports passed: false or times out', async () => {
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        generations: 1,
        stages: [
          countStage,
          {
            name: 'slow',
            timeoutMs: 5,
            evaluate: (program, context) =>
              increments(program) > 0
                ? new Promise((_resolve, reject) =>
                    context.signal.addEventListener('abort', () => reject(context.signal.reason)),
                  )
                : { score: 0, passed: true },
          },
        ],
      }),
    ).result;
    const children = await store.listCandidates(result, { generation: 1 });
    expect(children[0]).toMatchObject({
      accepted: false,
      rejection: { kind: 'evaluation', stage: 'slow' },
    });
    expect(children[0]!.rejection!.message).toMatch(/timed out/);
    expect(children[0]!.artifacts?.error).toMatch(/timed out/);

    const flagged = createInMemoryPopulationStore();
    const second = await evolve(
      options({
        store: flagged,
        generations: 1,
        stages: [{ name: 'gate', evaluate: () => ({ score: 5, passed: false }) }],
      }),
    ).result;
    expect(second.best).toBeUndefined();
    expect((await flagged.listCandidates(second))[0]!.rejection).toMatchObject({
      kind: 'cascade',
      stage: 'gate',
    });
  });
});

describe('evolve: stopping', () => {
  it('stops on the target score', async () => {
    const result = await evolve(options({ generations: 10, stopWhen: { targetScore: 2 } })).result;
    expect(result).toMatchObject({ status: 'completed', reason: 'target', generation: 2 });
  });

  it('stops on a plateau', async () => {
    const flat: EvolveStage = { evaluate: () => ({ score: 1 }) };
    const result = await evolve(
      options({ generations: 10, stages: [flat], stopWhen: { plateau: 2 } }),
    ).result;
    expect(result).toMatchObject({ status: 'completed', reason: 'plateau', generation: 2 });
  });

  it('stops cleanly on budget exhaustion and keeps the ledger bounded', async () => {
    const { model, counter } = grower();
    const store = createInMemoryPopulationStore();
    const result = await evolve(
      options({
        store,
        models: [{ model }],
        generations: 20,
        mutationsPerGeneration: 2,
        concurrency: 1,
        maxOutputTokens: 10,
        budget: { tokens: 600 },
      }),
    ).result;
    expect(result).toMatchObject({ status: 'stopped', reason: 'budget' });
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThan(40);
    expect(result.totals.spent.tokens).toBe(15 * counter.calls);
    const stored = await store.loadRun(result);
    expect(stored).toMatchObject({ status: 'stopped', reason: 'budget' });
    // Finished candidate scopes are compacted: no per-request records remain.
    expect(stored!.executionState!.ledger.reservations).toEqual([]);
    expect(stored!.executionState!.ledger.aggregates?.length).toBe(1);
  });

  it('drain finishes the current generation and cancel stops at once', async () => {
    const drained = evolve(options({ generations: 5 }));
    for await (const event of drained.events())
      if (event.type === 'generation.started' && event.generation === 1) {
        void drained.drain();
        break;
      }
    expect(await drained.result).toMatchObject({
      status: 'stopped',
      reason: 'drained',
      generation: 1,
    });

    const store = createInMemoryPopulationStore();
    const cancelled = evolve(options({ store, generations: 5 }));
    for await (const event of cancelled.events())
      if (event.type === 'generation.started' && event.generation === 1) {
        void cancelled.cancel();
        break;
      }
    const result = await cancelled.result;
    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(await store.loadRun(result)).toMatchObject({ status: 'stopped', reason: 'cancelled' });
  });
});

describe('evolve: durable resume', () => {
  /** A store that dies on one generation commit, after every slot of it is stored. */
  function crashingOn(generation: number): PopulationStore & { armed: boolean } {
    const inner = createInMemoryPopulationStore();
    const store = {
      ...inner,
      armed: true,
      async commitGeneration(commit: Parameters<PopulationStore['commitGeneration']>[0]) {
        if (store.armed && commit.run.generation === generation) {
          store.armed = false;
          throw new Error('crash');
        }
        return inner.commitGeneration(commit);
      },
    };
    return store;
  }

  it('resumes with zero model calls for stored slots and matches an uninterrupted run', async () => {
    const reference = createInMemoryPopulationStore();
    const uninterrupted = await evolve(options({ store: reference, selection: 'weighted' })).result;

    const store = crashingOn(2);
    await expect(evolve(options({ store, selection: 'weighted' })).result).rejects.toThrow('crash');
    const crashed = await store.loadRun({ scope: 'tenant', runId: 'run' });
    expect(crashed?.generation).toBe(1);
    // Ledger saves between slots never leak the uncommitted generation's population.
    expect(
      [...crashed!.islands.flatMap((island) => island.members), ...crashed!.archive].some((id) =>
        id.startsWith('g2-'),
      ),
    ).toBe(false);
    expect(
      await store.listCandidates({ scope: 'tenant', runId: 'run' }, { generation: 2 }),
    ).toHaveLength(2);

    const { model, counter } = grower();
    const handle = resumeEvolve(
      options({
        store,
        selection: 'weighted',
        models: [{ model }],
        seed: undefined,
        generations: 2,
      }),
    );
    const events = collect(handle.events());
    const result = await handle.result;
    expect(counter.calls).toBe(0);
    expect(result.modelCalls).toBe(0);
    expect(result.generation).toBe(2);
    expect(
      (await events)
        .filter((event) => event.type === 'candidate')
        .every((event) => event.type === 'candidate' && event.replayed),
    ).toBe(true);

    // Continue to generation 3: new slots call the model again, and the history matches.
    const next = await resumeEvolve(options({ store, selection: 'weighted', models: [{ model }] }))
      .result;
    expect(counter.calls).toBe(2);
    expect(next.best?.program).toBe(uninterrupted.best?.program);
    expect(strip(await store.listCandidates(next))).toEqual(
      strip(await reference.listCandidates(uninterrupted)),
    );
  });

  it('resuming a finished run returns it without calling anything', async () => {
    const store = createInMemoryPopulationStore();
    const first = await evolve(options({ store })).result;
    const { model, counter } = grower();
    const again = await resumeEvolve(options({ store, models: [{ model }] })).result;
    expect(counter.calls).toBe(0);
    expect(again).toMatchObject({ status: 'completed', generation: first.generation });
    expect(again.best?.id).toBe(first.best?.id);
  });

  it('refuses a missing run, a changed seed program and an existing run', async () => {
    const store = createInMemoryPopulationStore();
    await expect(resumeEvolve(options({ store })).result).rejects.toThrow(/not found/i);
    await evolve(options({ store, generations: 1 })).result;
    await expect(evolve(options({ store })).result).rejects.toMatchObject({
      name: 'EvolveConflictError',
    });
    await expect(resumeEvolve(options({ store, initial: 'other' })).result).rejects.toThrow(
      /initial program/i,
    );
    await expect(
      resumeEvolve(options({ store, mutationsPerGeneration: 5 })).result,
    ).rejects.toThrow(/shape/i);
  });
});

describe('evolve: validation', () => {
  it('rejects bad options synchronously', () => {
    expect(() => evolve({ ...options(), budget: undefined as never })).toThrow(/budget/);
    expect(() => evolve(options({ budget: {} }))).toThrow(/budget/);
    expect(() => evolve(options({ models: [] }))).toThrow(/models/);
    expect(() => evolve(options({ stages: [] }))).toThrow(/stages/);
    expect(() => evolve(options({ mutationsPerGeneration: 0 }))).toThrow(/mutationsPerGeneration/);
    expect(() => evolve(options({ selection: { boltzmann: 0 } }))).toThrow(/boltzmann/);
    expect(() => evolve(options({ patch: { diff: 0 } }))).toThrow(/patch/);
    expect(() =>
      evolve(options({ islands: { count: 2, migrationEvery: 1, migrationRate: 2 } })),
    ).toThrow(/migrationRate/);
  });
});
