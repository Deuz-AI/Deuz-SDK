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

const key = { scope: 'tenant', runId: 'run' };
const leaseKey = `evolve:${JSON.stringify(['tenant', 'run'])}`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * A run stopped by a drain while a cancel sent through the provider was still
 * queued: it reached the holder after its last renewal.
 */
async function drainedWithQueuedCancel(store: PopulationStore, provider: LeaseProvider) {
  const { stage, open } = gated();
  const first = evolve(options({ store, stages: [stage], lease: { provider, owner: 'a' } }));
  await started(first);
  expect(await provider.signal(leaseKey, 'cancel')).toBe(true);
  const drained = first.drain();
  open();
  await drained;
  expect(await first.result).toMatchObject({ status: 'stopped', reason: 'drained', generation: 0 });
}

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

  it('drops a cancel that lost the race to the run end, so extending the run works', async () => {
    const store = createInMemoryPopulationStore();
    const provider = createInMemoryLeaseProvider();
    const { stage, open } = gated();
    const first = evolve(options({ store, stages: [stage], lease: { provider, owner: 'a' } }));
    await started(first);
    // The cancel reaches the provider mid-run, but the run completes before any heartbeat.
    expect(await provider.signal(leaseKey, 'cancel')).toBe(true);
    open();
    expect(await first.result).toMatchObject({ status: 'completed', reason: 'generations' });
    let renewals = 0;
    const counting: LeaseProvider = {
      ...provider,
      async renew(lease, ttlMs) {
        renewals++;
        return provider.renew(lease, ttlMs);
      },
    };
    const later = gated();
    const extended = resumeEvolve(
      options({
        store,
        stages: [later.stage],
        generations: 4,
        lease: { provider: counting, owner: 'b', ttlMs: 30 },
      }),
    );
    // Heartbeats run while generation 3 waits on its evaluator.
    for (let wait = 0; wait < 100 && renewals < 3; wait++) await pause();
    later.open();
    expect(await extended.result).toMatchObject({
      status: 'completed',
      reason: 'generations',
      generation: 4,
    });
    // The stale request was delivered and dropped, not left for the next holder.
    const probe = (await provider.acquire({ key: leaseKey, owner: 'x', ttlMs: 30_000 }))!;
    expect(await provider.renew(probe, 30_000)).toMatchObject({ held: true, signals: [] });
  });

  it('applies a cancel queued after the last renewal before the next executor calls a model', async () => {
    const store = createInMemoryPopulationStore();
    const provider = createInMemoryLeaseProvider();
    await drainedWithQueuedCancel(store, provider);
    const resumed = await resumeEvolve(options({ store, lease: { provider, owner: 'b' } })).result;
    expect(resumed).toMatchObject({
      status: 'stopped',
      reason: 'cancelled',
      generation: 0,
      modelCalls: 0,
    });
    expect(await store.loadRun(key)).toMatchObject({ status: 'stopped', reason: 'cancelled' });
  });

  it('keeps a queued cancel for the next executor when a resume fails', async () => {
    const store = createInMemoryPopulationStore();
    const provider = createInMemoryLeaseProvider();
    await drainedWithQueuedCancel(store, provider);
    // Refused before it takes the queued signals.
    await expect(
      resumeEvolve(options({ store, mutationsPerGeneration: 3, lease: { provider, owner: 'b' } }))
        .result,
    ).rejects.toThrow(/shape/);
    // Refused after it took them: it queues the cancel again.
    await expect(
      resumeEvolve(options({ store, initial: 'other', lease: { provider, owner: 'c' } })).result,
    ).rejects.toThrow(/initial program/);
    const resumed = await resumeEvolve(options({ store, lease: { provider, owner: 'd' } })).result;
    expect(resumed).toMatchObject({ status: 'stopped', reason: 'cancelled', modelCalls: 0 });
  });

  it('queues a cancel again when the run fails to record the stop it asked for', async () => {
    const inner = createInMemoryPopulationStore();
    let refuse = true;
    const flaky: PopulationStore = {
      ...inner,
      async saveRun(record) {
        if (refuse && record.status === 'stopped' && record.reason === 'cancelled') {
          refuse = false;
          throw new Error('store down');
        }
        return inner.saveRun(record);
      },
    };
    const provider = createInMemoryLeaseProvider();
    const { stage } = gated();
    const handle = evolve(
      options({ store: flaky, stages: [stage], lease: { provider, owner: 'a', ttlMs: 30 } }),
    );
    await started(handle);
    // The next heartbeat delivers it, and saving the stop fails.
    expect(await provider.signal(leaseKey, 'cancel')).toBe(true);
    await expect(handle.result).rejects.toThrow('store down');
    expect(await inner.loadRun(key)).toMatchObject({ status: 'failed' });
    const resumed = await resumeEvolve(options({ store: inner, lease: { provider, owner: 'b' } }))
      .result;
    expect(resumed).toMatchObject({ status: 'stopped', reason: 'cancelled', modelCalls: 0 });
  });

  it('lets a run stopped as cancelled resume despite a cancel that raced that stop', async () => {
    const store = createInMemoryPopulationStore();
    const provider = createInMemoryLeaseProvider();
    const { stage, open } = gated();
    const first = evolve(options({ store, stages: [stage], lease: { provider, owner: 'a' } }));
    await started(first);
    // A cancel through the provider races a local cancel, which stops the run first.
    expect(await provider.signal(leaseKey, 'cancel')).toBe(true);
    await first.cancel();
    open();
    expect(await first.result).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    const resumed = await resumeEvolve(options({ store, lease: { provider, owner: 'b' } })).result;
    expect(resumed).toMatchObject({ status: 'completed', reason: 'generations', generation: 2 });
  });

  it('rejects a lease ttl too short to renew', () => {
    expect(() =>
      evolve(options({ lease: { provider: createInMemoryLeaseProvider(), ttlMs: 2 } })),
    ).toThrow(/ttlMs/);
  });
});
