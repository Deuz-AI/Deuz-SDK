import { describe, expect, it } from 'vitest';
import { createInMemorySwarmStore, createSwarm, SwarmLeaseError } from '../src/swarm';
import { createInMemoryLeaseProvider } from '../src/ops';
import { swarmKey } from '../src/swarm/store';
import type { Clock } from '../src/types/deps';
import type { LeaseProvider } from '../src/types/lease';
import type {
  SwarmCommit,
  SwarmReducerBinding,
  SwarmSnapshot,
  SwarmStore,
  SwarmTask,
} from '../src/types/swarm';
import { manualClock } from './fixtures/manual-clock';

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

const key = { scope: 'tenant', runId: 'run' };
const leaseKey = `swarm:${swarmKey(key)}`;
const tasks: SwarmTask[] = [{ id: 'a', reducer: 'work', replay: 'safe' }];
const work: SwarmReducerBinding = { execute: () => 1 };

const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

/** The commit that records a cancellation (2.2): the run.cancelled event. */
const cancelling = (change: SwarmCommit) =>
  (change.events ?? []).some((event) => event.type === 'run.cancelled');
/** The commit cancel() makes when the run already records the request: an empty change. */
const empty = (change: SwarmCommit) =>
  !change.run && !change.tasks && !change.spawn && !change.posts && !change.events;

/** A store whose first commit that matches fails once, like a transient outage. */
function failingOnce(store: SwarmStore, match: (change: SwarmCommit) => boolean) {
  const outage = new Error('injected store outage');
  let armed = true;
  const flaky: SwarmStore = {
    ...store,
    async commit(change) {
      if (armed && match(change)) {
        armed = false;
        throw outage;
      }
      return store.commit(change);
    },
  };
  return { store: flaky, outage, arm: () => (armed = true) };
}

/** A run whose executor crashed: running, one pending task, nobody drives it. */
function orphan(): SwarmSnapshot {
  return {
    run: {
      kind: 'deuz-swarm',
      version: 1,
      ...key,
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
        task: { id: 'a', reducer: 'work', replay: 'safe' },
        bindingVersion: '1',
        status: 'pending',
        attempt: 0,
      },
    ],
  };
}

function swarmOn(input: {
  store: SwarmStore;
  clock?: Clock;
  provider?: LeaseProvider;
  owner?: string;
  reducer?: SwarmReducerBinding;
}) {
  return createSwarm({
    agents: {},
    store: input.store,
    reducers: { work: input.reducer ?? work },
    ...(input.clock ? { deps: { clock: input.clock } } : {}),
    ...(input.provider
      ? { lease: { provider: input.provider, owner: input.owner ?? 'a', ttlMs: 3_000 } }
      : {}),
  });
}

describe('swarm executor cleanup (2.3)', () => {
  it('lets the run be resumed after the cancel commit at start fails', async () => {
    const base = createInMemorySwarmStore();
    const { store, outage } = failingOnce(base, cancelling);
    const swarm = swarmOn({ store });
    // The signal is already aborted, so start() commits the cancellation first.
    await expect(swarm.run({ ...key, tasks, signal: aborted() })).rejects.toBe(outage);
    expect(await base.head!(key)).toMatchObject({ status: 'running', cancelRequested: false });
    // The failed executor gave its ownership back: the same swarm resumes the run.
    const outcome = await (await swarm.resume(key)).result;
    expect(outcome.run.status).toBe('completed');
  });

  it('lets another swarm on the same store resume after the cancel commit at start fails', async () => {
    const base = createInMemorySwarmStore();
    const { store, outage } = failingOnce(base, cancelling);
    await expect(swarmOn({ store }).run({ ...key, tasks, signal: aborted() })).rejects.toBe(outage);
    const outcome = await (await swarmOn({ store }).resume(key)).result;
    expect(outcome.run.status).toBe('completed');
  });

  it('releases the lease and stops the heartbeat, so recover() takes the run over', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const base = createInMemorySwarmStore();
    const { store, outage } = failingOnce(base, cancelling);
    const a = swarmOn({ store, clock: time.clock, provider, owner: 'a' });
    await expect(a.run({ ...key, tasks, signal: aborted() })).rejects.toBe(outage);
    // No heartbeat keeps renewing a lease nobody uses.
    expect(time.pending()).toBe(0);
    await time.advance(30_000);
    expect(time.pending()).toBe(0);
    // The lease is free at once, not only after it expires.
    const b = swarmOn({ store: { ...base }, clock: time.clock, provider, owner: 'b' });
    const { handles, failed } = await b.recover();
    expect(failed).toEqual([]);
    expect(handles).toHaveLength(1);
    expect((await handles[0]!.result).run.status).toBe('completed');
    expect(time.pending()).toBe(0);
  });

  it('releases the lease right away when the cancel commit at start fails', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const base = createInMemorySwarmStore();
    const { store, outage } = failingOnce(base, cancelling);
    const a = swarmOn({ store, clock: time.clock, provider, owner: 'a' });
    await expect(a.run({ ...key, tasks, signal: aborted() })).rejects.toBe(outage);
    const probe = await provider.acquire({ key: leaseKey, owner: 'probe', ttlMs: 3_000 });
    expect(probe).toMatchObject({ owner: 'probe', token: 2 });
  });

  it('cleans up when the cancel commit of a resume with a recorded cancel fails', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const base = createInMemorySwarmStore();
    await base.create(orphan(), [{ type: 'run.started', timestamp: 1 }]);
    const { store, outage, arm } = failingOnce(base, empty);
    const swarm = swarmOn({ store, clock: time.clock, provider, owner: 'a' });
    // Nobody drives the run, so the request is recorded on it.
    expect(await swarm.requestCancel(key)).toBe('recorded');
    arm();
    // The resume commits its claim, then start() commits the recorded cancel.
    await expect(swarm.resume(key)).rejects.toBe(outage);
    expect(time.pending()).toBe(0);
    // The store is healthy again: nothing left over blocks the next resume.
    const other = swarmOn({ store: { ...base }, clock: time.clock, provider, owner: 'b' });
    const outcome = await (await other.resume(key)).result;
    expect(outcome.run).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(outcome.tasks[0]?.status).toBe('cancelled');
    // And the swarm whose resume failed holds no stale ownership of the run.
    expect((await (await swarm.resume(key)).result).run.status).toBe('cancelled');
    expect(time.pending()).toBe(0);
  });

  it('cleans up the resume path without a lease too', async () => {
    const base = createInMemorySwarmStore();
    await base.create(orphan(), [{ type: 'run.started', timestamp: 1 }]);
    const { store, outage, arm } = failingOnce(base, empty);
    const swarm = swarmOn({ store });
    expect(await swarm.requestCancel(key)).toBe('recorded');
    arm();
    await expect(swarm.resume(key)).rejects.toBe(outage);
    const outcome = await (await swarm.resume(key)).result;
    expect(outcome.run).toMatchObject({ status: 'cancelled', cancelRequested: true });
  });

  it('still refuses a second executor in this process while the first drives the run', async () => {
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls = { count: 0 };
    const slow: SwarmReducerBinding = {
      async execute() {
        calls.count++;
        await release.promise;
        return calls.count;
      },
    };
    const swarm = swarmOn({ store, reducer: slow });
    const handle = await swarm.run({ ...key, tasks });
    await until(() => calls.count === 1);
    await expect(swarm.resume(key)).rejects.toThrow('already has an executor');
    // Another swarm instance on the same store object is refused as well.
    await expect(swarmOn({ store, reducer: slow }).resume(key)).rejects.toThrow(
      'already has an executor',
    );
    const revision = (await store.head!(key))!.revision;
    release.resolve();
    expect((await handle.result).run.status).toBe('completed');
    expect((await store.head!(key))!.revision).toBeGreaterThan(revision);
    // Its ownership ends with it.
    expect((await (await swarm.resume(key)).result).run.status).toBe('completed');
  });

  it('still refuses a second executor in another process while the lease is held', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls = { count: 0 };
    const slow: SwarmReducerBinding = {
      async execute() {
        calls.count++;
        await release.promise;
        return calls.count;
      },
    };
    const a = swarmOn({ store, clock: time.clock, provider, owner: 'a', reducer: slow });
    const handle = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    const b = swarmOn({ store: { ...store }, clock: time.clock, provider, owner: 'b' });
    await expect(b.resume(key)).rejects.toBeInstanceOf(SwarmLeaseError);
    release.resolve();
    expect((await handle.result).run.status).toBe('completed');
    expect(time.pending()).toBe(0);
  });
});
