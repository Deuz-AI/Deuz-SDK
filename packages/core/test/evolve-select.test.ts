import { describe, expect, it } from 'vitest';
import { createRng, hashSeed } from '../src/evolve/random';
import {
  chooseModel,
  pickInspirations,
  pickParent,
  pickPatchType,
  rankCandidates,
  updateArchive,
} from '../src/evolve/selection';
import { buildMutationPrompt } from '../src/evolve/prompt';

const members = [
  { id: 'a', score: 1, accepted: true },
  { id: 'b', score: 5, accepted: true },
  { id: 'c', score: 3, accepted: true },
  { id: 'd', accepted: false },
];

describe('seeded randomness', () => {
  it('is deterministic per key and in [0, 1)', () => {
    const first = createRng('seed', 1, 0, 2);
    const again = createRng('seed', 1, 0, 2);
    const other = createRng('seed', 1, 0, 3);
    const a = [first(), first(), first()];
    expect([again(), again(), again()]).toEqual(a);
    expect(other()).not.toBe(a[0]);
    for (const value of a) expect(value >= 0 && value < 1).toBe(true);
    expect(hashSeed('x')).toBe(hashSeed('x'));
  });
});

describe('rankCandidates', () => {
  it('orders accepted first, then by score, then by ID', () => {
    expect(
      rankCandidates([...members, { id: 'e', score: 5, accepted: true }]).map((item) => item.id),
    ).toEqual(['b', 'e', 'c', 'a', 'd']);
  });
});

describe('pickParent', () => {
  const draw = (selection: Parameters<typeof pickParent>[2]['selection'], n = 400) => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const parent = pickParent(members, [], {
        rng: createRng('s', i),
        selection,
        eliteRatio: 0,
        exploreRatio: 0,
      });
      counts[parent.id] = (counts[parent.id] ?? 0) + 1;
    }
    return counts;
  };

  it('beam always takes the best', () => {
    expect(draw('beam', 20)).toEqual({ b: 20 });
  });

  it('weighted favours higher scores and never picks an unscored member', () => {
    const counts = draw('weighted');
    expect(counts.b!).toBeGreaterThan(counts.c!);
    expect(counts.c!).toBeGreaterThan(counts.a ?? 0);
    expect(counts.d).toBeUndefined();
  });

  it('power-law favours rank', () => {
    const counts = draw('power-law');
    expect(counts.b!).toBeGreaterThan(counts.c!);
    expect(counts.c!).toBeGreaterThan(counts.a!);
  });

  it('a cold Boltzmann is greedy and a hot one spreads out', () => {
    expect(draw({ boltzmann: 0.01 }, 50)).toEqual({ b: 50 });
    expect(Object.keys(draw({ boltzmann: 100 })).length).toBeGreaterThanOrEqual(3);
  });

  it('explore draws uniformly from the island and elite draws from the archive', () => {
    const explored = new Set<string>();
    for (let i = 0; i < 200; i++)
      explored.add(
        pickParent(members, [], {
          rng: createRng('e', i),
          selection: 'beam',
          eliteRatio: 0,
          exploreRatio: 1,
        }).id,
      );
    expect(explored).toEqual(new Set(['a', 'b', 'c', 'd']));
    const elite = pickParent(members, [{ id: 'z', score: 9, accepted: true }], {
      rng: createRng('x'),
      selection: 'beam',
      eliteRatio: 1,
      exploreRatio: 0,
    });
    expect(elite.id).toBe('z');
  });

  it('falls back to uniform when nothing is scored', () => {
    const parent = pickParent([{ id: 'q' }, { id: 'r' }], [], {
      rng: createRng('u'),
      selection: 'weighted',
      eliteRatio: 0,
      exploreRatio: 0,
    });
    expect(['q', 'r']).toContain(parent.id);
  });
});

describe('pickInspirations', () => {
  it('takes the best programs then random diverse ones, never the parent', () => {
    const pool = [
      ...members,
      { id: 'e', score: 4, accepted: true },
      { id: 'f', score: 0, accepted: true },
    ];
    const picked = pickInspirations(pool, ['b'], { rng: createRng('i'), top: 2, diverse: 2 });
    expect(picked.slice(0, 2).map((item) => item.id)).toEqual(['e', 'c']);
    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((item) => item.id)).size).toBe(4);
    expect(picked.some((item) => item.id === 'b')).toBe(false);
  });
});

describe('pickPatchType', () => {
  it('follows the probabilities and degrades cross without a second parent', () => {
    const counts = { diff: 0, full: 0, cross: 0 };
    for (let i = 0; i < 1000; i++)
      counts[pickPatchType(createRng('p', i), { diff: 0.6, full: 0.3, cross: 0.1 }, true)]++;
    expect(counts.diff).toBeGreaterThan(500);
    expect(counts.full).toBeGreaterThan(200);
    expect(counts.cross).toBeGreaterThan(50);
    expect(pickPatchType(createRng('p'), { diff: 0, full: 0, cross: 1 }, false)).toBe('diff');
  });
});

describe('chooseModel (UCB1)', () => {
  it('tries every model once, then prefers the higher mean reward', () => {
    expect(chooseModel({ pulls: [0, 0], rewards: [0, 0] }, [1, 1], [0, 0])).toBe(0);
    expect(chooseModel({ pulls: [1, 0], rewards: [0, 0] }, [1, 1], [0, 0])).toBe(1);
    expect(chooseModel({ pulls: [0, 0], rewards: [0, 0] }, [1, 1], [1, 0])).toBe(1);
    expect(chooseModel({ pulls: [10, 10], rewards: [8, 1] }, [1, 1], [0, 0])).toBe(0);
    // An under-explored arm eventually wins the bonus back.
    expect(chooseModel({ pulls: [200, 2], rewards: [100, 1] }, [1, 1], [0, 0])).toBe(1);
  });

  it('never picks a zero-weight model', () => {
    expect(chooseModel({ pulls: [0, 0], rewards: [0, 0] }, [0, 1], [0, 0])).toBe(1);
  });
});

describe('updateArchive', () => {
  const lookup = (
    items: { id: string; score?: number; accepted?: boolean; features?: Record<string, number> }[],
  ) => new Map(items.map((item) => [item.id, item]));

  it('keeps the global top list without features', () => {
    const all = lookup([
      { id: 'a', score: 1, accepted: true },
      { id: 'b', score: 3, accepted: true },
      { id: 'c', score: 2, accepted: true },
    ]);
    expect(updateArchive(['a'], ['b', 'c'], all, { archiveSize: 2, featureBins: 10 })).toEqual([
      'b',
      'c',
    ]);
  });

  it('keeps one elite per MAP-Elites cell', () => {
    const all = lookup([
      { id: 'a', score: 1, accepted: true, features: { size: 0.1 } },
      { id: 'b', score: 3, accepted: true, features: { size: 0.12 } },
      { id: 'c', score: 2, accepted: true, features: { size: 0.9 } },
    ]);
    expect(updateArchive([], ['a', 'b', 'c'], all, { archiveSize: 5, featureBins: 10 })).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('buildMutationPrompt', () => {
  const parent = {
    id: 'g0-i0-s0',
    program: '# EVOLVE-BLOCK-START\nx = 1\n# EVOLVE-BLOCK-END\n',
    score: 0.5,
    metrics: { speed: 2 },
    artifacts: { stderr: 'warning: slow' },
  };

  it('asks for SEARCH/REPLACE diffs and carries parent, inspirations and failures', () => {
    const { system, prompt } = buildMutationPrompt({
      instructions: 'Make it fast.',
      patchType: 'diff',
      generation: 3,
      parent,
      inspirations: [{ id: 'g1-i0-s1', program: 'y = 2', score: 0.4 }],
      failures: [
        {
          id: 'g2-i0-s0',
          program: 'broken',
          artifacts: { stderr: 'Traceback: boom' },
          rejection: { kind: 'evaluation', message: 'boom' },
        },
      ],
    });
    expect(system).toContain('<<<<<<< SEARCH');
    expect(system).toContain('EVOLVE-BLOCK');
    expect(prompt).toContain('Make it fast.');
    expect(prompt).toContain(parent.program);
    expect(prompt).toContain('0.5');
    expect(prompt).toContain('speed');
    expect(prompt).toContain('warning: slow');
    expect(prompt).toContain('y = 2');
    expect(prompt).toContain('Traceback: boom');
  });

  it('asks for a full program for full rewrites and shows both parents for crossover', () => {
    const full = buildMutationPrompt({
      patchType: 'full',
      generation: 1,
      parent,
      inspirations: [],
    });
    expect(full.system).toContain('complete program');
    expect(full.system).not.toContain('<<<<<<< SEARCH');
    const cross = buildMutationPrompt({
      patchType: 'cross',
      generation: 1,
      parent,
      secondParent: { program: 'z = 3', score: 0.7 },
      inspirations: [],
    });
    expect(cross.prompt).toContain('z = 3');
    expect(cross.system).toMatch(/combine/i);
  });
});
