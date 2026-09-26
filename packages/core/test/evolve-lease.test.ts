import { describe, expect, it } from 'vitest';
import { evolve, resumeEvolve } from '../src/evolve/controller';
import { createInMemoryPopulationStore } from '../src/evolve/store';
import { createInMemoryLeaseProvider } from '../src/ops';
import { createMockModel } from '../src/testing';
import type { EvolveOptions, EvolveStage, PopulationStore } from '../src/evolve/types';
import type { LeaseProvider, LeaseSignal } from '../src/types/lease';

const initial = [
  'def f(x):',
  '    # EVOLVE-BLOCK-START',
  '    return x',
  '    # EVOLVE-BLOCK-END',
  '',
].join('\n');
const GROW = '<<<<<<< SEARCH\n    return x\n=======\n    x = x + 1\n    return x\n>>>>>>> REPLACE';
const increments = (program: string) => program.split('x = x + 1').length - 1;

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

/** A stage that waits until the test opens the gate. */
function gated() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const stage: EvolveStage = {
    name: 'gated',
    evaluate: async (program) => {
      await gate;
      return { score: increments(program) };
    },
  };
  return { stage, open };
}

function options(overrides: Partial<EvolveOptions> = {}): EvolveOptions {
  return {
    scope: 'tenant',
    runId: 'run',
    initial,
    stages: [{ name: 'count', evaluate: (program) => ({ score: increments(program) }) }],
    models: [{ model: createMockModel({ responses: [{ text: GROW }] }) }],
    store: createInMemoryPopulationStore(),
    generations: 2,
    mutationsPerGeneration: 1,
    selection: 'beam',
    patch: { diff: 1 },
    budget: { tokens: 1_000_000 },
    seed: 'fixed',
    deps,
    ...overrides,
  };
}

/** Delivers one signal on the first renewal, then behaves like the provider it wraps. */
function signalling(provider: LeaseProvider, signal: LeaseSignal): LeaseProvider {
  let sent = false;
  return {
    ...provider,
    async renew(lease, ttlMs) {
      const renewal = await provider.renew(lease, ttlMs);
      if (!renewal.held || sent) return renewal;
      sent = true;
      return { ...renewal, signals: [...renewal.signals, signal] };
    },
  };
}

const started = async (handle: ReturnType<typeof evolve>) => {
  for await (const event of handle.events()) if (event.type === 'generation.started') return;
};

describe('evolve leases (2.2)', () => {
  it('refuses a run another executor holds, and releases it when it finishes', async () => {
    const store = createInMemoryPopulationStore();
    const provider = createInMemoryLeaseProvider();
    const { stage, open } = gated();
    const first = evolve(options({ store, stages: [stage], lease: { provider, owner: 'a' } }));
    await started(first);
    const second = resumeEvolve(options({ store, lease: { provider, owner: 'b' } }));
    await expect(second.result).rejects.toMatchObject({ name: 'EvolveLeaseError', code: 'held' });
    open();
    expect((await first.result).status).toBe('completed');
    const again = resumeEvolve(options({ store, lease: { provider, owner: 'b' } }));
    expect((await again.result).status).toBe('completed');
  });

  it('stops before its next write when it loses the lease', async () => {
    const store: PopulationStore = createInMemoryPopulationStore();
    const inner = createInMemoryLeaseProvider();
    let lost = false;
    let renewals = 0;
    const provider: LeaseProvider = {
      ...inner,
      async renew(lease, ttlMs) {
        renewals++;
        return lost ? { held: false } : inner.renew(lease, ttlMs);
      },
    };
    const { stage, open } = gated();
    const handle = evolve(options({ store, stages: [stage], lease: { provider, ttlMs: 30 } }));
    await started(handle);
    // The run stops as soon as the loss is seen, so listen before waiting for it.
    const stopped = expect(handle.result).rejects.toMatchObject({
      name: 'EvolveLeaseError',
      code: 'lost',
    });
    lost = true;
    const seen = renewals;
    while (renewals === seen) await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    await stopped;
    // The run is left for the next executor, never marked failed by this one.
    expect(await store.loadRun({ scope: 'tenant', runId: 'run' })).toMatchObject({
      status: 'running',
      generation: -1,
    });
  });

  it('drains or cancels on a signal delivered through the lease', async () => {
    for (const [signal, reason] of [
      ['drain', 'drained'],
      ['cancel', 'cancelled'],
    ] as const) {
      const { stage, open } = gated();
      const provider = signalling(createInMemoryLeaseProvider(), signal);
      let renewed!: () => void;
      const delivered = new Promise<void>((resolve) => (renewed = resolve));
      const handle = evolve(
        options({
          stages: [stage],
          lease: {
            provider: {
              ...provider,
              async renew(lease, ttlMs) {
                const renewal = await provider.renew(lease, ttlMs);
                renewed();
                return renewal;
              },
            },
            ttlMs: 30,
          },
        }),
      );
      await started(handle);
      await delivered;
      open();
      expect(await handle.result).toMatchObject({ status: 'stopped', reason });
    }
  });

  it('rejects a lease ttl too short to renew', () => {
    expect(() =>
      evolve(options({ lease: { provider: createInMemoryLeaseProvider(), ttlMs: 2 } })),
    ).toThrow(/ttlMs/);
  });
});
