import { describe, expect, it } from 'vitest';
import {
  createInMemorySwarmStore,
  createSwarm,
  SwarmConflictError,
  SwarmLeaseError,
} from '../src/swarm';
import { createInMemoryLeaseProvider } from '../src/ops';
import { swarmKey } from '../src/swarm/store';
import type { Clock } from '../src/types/deps';
import type { LeaseProvider } from '../src/types/lease';
import type {
  SwarmReducerBinding,
  SwarmRunStatus,
  SwarmSnapshot,
  SwarmStore,
  SwarmTask,
  SwarmTaskRecord,
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

/** Another process's connection to the same durable store. */
const connection = (store: SwarmStore): SwarmStore => ({ ...store });

/** A reducer that waits for its gate, or for the run to abort it. */
function slow(release: Promise<void>, calls: { count: number }): SwarmReducerBinding {
  return {
    async execute(_results, context) {
      calls.count++;
      await new Promise<void>((resolve, reject) => {
        void release.then(resolve);
        context.signal.addEventListener('abort', () => reject(context.signal.reason as Error), {
          once: true,
        });
      });
      return calls.count;
    },
  };
}

const key = { scope: 'tenant', runId: 'run' };
const leaseKey = `swarm:${swarmKey(key)}`;
const tasks: SwarmTask[] = [{ id: 'a', reducer: 'work', replay: 'safe' }];

function interrupted(): SwarmSnapshot {
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
        status: 'running',
        attempt: 1,
      },
    ],
  };
}

/** A stored run in another state, with its one task changed. */
function stored(status: SwarmRunStatus, task: Partial<SwarmTaskRecord>): SwarmSnapshot {
  const snapshot = interrupted();
  return { run: { ...snapshot.run, status }, tasks: [{ ...snapshot.tasks[0]!, ...task }] };
}

/**
 * A cancel that reached the previous holder after its last renewal: it then
 * released the run (it settled first) or its lease lapsed (it crashed).
 */
async function queueCancel(
  provider: LeaseProvider,
  end: 'released' | 'lapsed',
  time: { advance(ms: number): Promise<void> },
) {
  const holder = (await provider.acquire({ key: leaseKey, owner: 'previous', ttlMs: 3_000 }))!;
  expect(await provider.signal(leaseKey, 'cancel')).toBe(true);
  if (end === 'released') await provider.release(holder);
  else await time.advance(10_000);
}

function swarmOn(input: {
  store: SwarmStore;
  clock: Clock;
  provider?: LeaseProvider;
  owner: string;
  work: SwarmReducerBinding;
}) {
  return createSwarm({
    agents: {},
    store: input.store,
    reducers: { work: input.work },
    deps: { clock: input.clock },
    ...(input.provider
      ? { lease: { provider: input.provider, owner: input.owner, ttlMs: 3_000 } }
      : {}),
  });
}

describe('swarm leases', () => {
  it('refuses a second executor while the lease is held and releases it at the end', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls = { count: 0 };
    const a = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(release.promise, calls),
    });
    const handle = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    const b = swarmOn({
      store: connection(store),
      clock: time.clock,
      provider,
      owner: 'b',
      work: slow(release.promise, calls),
    });
    const revision = (await store.head!(key))!.revision;
    const refused = await b.resume(key).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SwarmLeaseError);
    expect(refused).toMatchObject({ code: 'held' });
    expect((await store.head!(key))!.revision).toBe(revision);
    release.resolve();
    expect((await handle.result).run.status).toBe('completed');
    expect(await provider.acquire({ key: leaseKey, owner: 'c', ttlMs: 1 })).toMatchObject({
      token: 2,
    });
    expect(time.pending()).toBe(0);
  });

  it('refuses to start a new run under a key another owner holds', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    await provider.acquire({ key: leaseKey, owner: 'other', ttlMs: 3_000 });
    const store = createInMemorySwarmStore();
    const a = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    await expect(a.run({ ...key, tasks })).rejects.toMatchObject({ code: 'held' });
    expect(await store.head!(key)).toBeUndefined();
  });

  it('renews the lease every ttl / 3 while it drives the run', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls = { count: 0 };
    const a = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(release.promise, calls),
    });
    const handle = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    // Four beats carry the lease well past its first 3 s expiry.
    for (let beat = 0; beat < 4; beat++) await time.advance(1_000);
    expect(await provider.acquire({ key: leaseKey, owner: 'x', ttlMs: 1 })).toBeUndefined();
    release.resolve();
    expect((await handle.result).run.status).toBe('completed');
    expect(await provider.acquire({ key: leaseKey, owner: 'x', ttlMs: 1 })).toBeDefined();
  });

  it('stops a zombie executor whose lease another process took over', async () => {
    const time = manualClock();
    const frozen = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const stuck = gate();
    const calls = { count: 0 };
    // A's clock stands still: it misses every heartbeat, like a paused process.
    const a = swarmOn({
      store,
      clock: frozen.clock,
      provider,
      owner: 'a',
      work: slow(stuck.promise, calls),
    });
    const zombie = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    await time.advance(10_000);
    const b = swarmOn({
      store: connection(store),
      clock: time.clock,
      provider,
      owner: 'b',
      work: slow(Promise.resolve(), calls),
    });
    const taken = await b.resume(key);
    const outcome = await taken.result;
    expect(outcome.run.status).toBe('completed');
    expect(outcome.tasks[0]).toMatchObject({ status: 'completed', result: { output: 2 } });
    const settled = await store.head!(key);
    // A wakes up, finds the lease gone, and writes nothing more.
    await frozen.advance(1_000);
    stuck.resolve();
    const lost = await zombie.result.catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(SwarmLeaseError);
    expect(lost).toMatchObject({ code: 'lost' });
    expect(await store.head!(key)).toEqual(settled);
    expect(frozen.pending()).toBe(0);
  });

  it('reports a zombie as lost when its first write after a takeover meets the revision check', async () => {
    const time = manualClock();
    const frozen = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const stuck = gate();
    const calls = { count: 0 };
    const a = swarmOn({
      store,
      clock: frozen.clock,
      provider,
      owner: 'a',
      work: slow(stuck.promise, calls),
    });
    const zombie = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    await time.advance(10_000);
    const b = swarmOn({
      store: connection(store),
      clock: time.clock,
      provider,
      owner: 'b',
      work: slow(Promise.resolve(), calls),
    });
    expect((await (await b.resume(key)).result).run.status).toBe('completed');
    const settled = await store.head!(key);
    // A wakes up and its task finishes before any heartbeat fires, so its first
    // write reaches the store's revision check instead of a renewal.
    stuck.resolve();
    const lost = await zombie.result.catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(SwarmLeaseError);
    expect(lost).toMatchObject({ code: 'lost' });
    expect(await store.head!(key)).toEqual(settled);
  });

  it('keeps a revision conflict when the executor still holds its lease', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls = { count: 0 };
    const a = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(release.promise, calls),
    });
    const handle = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    // A process without the lease option records a cancel behind the holder's back.
    const unleased = swarmOn({
      store: connection(store),
      clock: time.clock,
      owner: 'b',
      work: slow(Promise.resolve(), calls),
    });
    expect(await unleased.requestCancel(key)).toBe('recorded');
    release.resolve();
    await expect(handle.result).rejects.toBeInstanceOf(SwarmConflictError);
  });

  it('treats a failing renew as lost only once the lease expired, leaving tasks running', async () => {
    const time = manualClock();
    const inner = createInMemoryLeaseProvider({ clock: time.clock });
    let down = false;
    const provider: LeaseProvider = {
      ...inner,
      renew: (lease, ttl) =>
        down ? Promise.reject(new Error('db down')) : inner.renew(lease, ttl),
    };
    const store = createInMemorySwarmStore();
    const stuck = gate();
    const calls = { count: 0 };
    const a = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(stuck.promise, calls),
    });
    const handle = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    down = true;
    let failed: unknown;
    void handle.result.catch((error: unknown) => {
      failed = error;
    });
    await time.advance(2_000);
    expect(failed).toBeUndefined();
    await time.advance(1_500);
    await until(() => failed !== undefined);
    expect(failed).toMatchObject({ code: 'lost' });
    stuck.resolve();
    const left = await store.load(key);
    expect(left?.tasks[0]).toMatchObject({ status: 'running', attempt: 1 });
    expect(left?.run.status).toBe('running');
    // The next executor takes it from there.
    const b = swarmOn({
      store: connection(store),
      clock: time.clock,
      provider: inner,
      owner: 'b',
      work: slow(Promise.resolve(), calls),
    });
    expect((await (await b.resume(key)).result).run.status).toBe('completed');
  });

  it('claims a resume only at the expected revision and status', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    await store.create(interrupted(), []);
    const swarm = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    await expect(swarm.resume({ ...key, expectedRevision: 3 })).rejects.toBeInstanceOf(
      SwarmConflictError,
    );
    await expect(swarm.resume({ ...key, expectedStatus: 'suspended' })).rejects.toBeInstanceOf(
      SwarmConflictError,
    );
    expect((await store.head!(key))!.revision).toBe(0);
    const handle = await swarm.resume({ ...key, expectedRevision: 0, expectedStatus: 'running' });
    expect((await handle.result).run.status).toBe('completed');
  });
});

describe('swarm requestCancel', () => {
  it('reports a finished run as settled', async () => {
    const time = manualClock();
    const store = createInMemorySwarmStore();
    const swarm = swarmOn({
      store,
      clock: time.clock,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    await (
      await swarm.run({ ...key, tasks })
    ).result;
    expect(await swarm.requestCancel(key)).toBe('settled');
  });

  it('records the request when nobody drives the run, and the next executor cancels it', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    await store.create(interrupted(), []);
    const swarm = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    expect(await swarm.requestCancel(key)).toBe('recorded');
    expect(await store.head!(key)).toMatchObject({ cancelRequested: true, revision: 1 });
    expect((await store.readEvents(key, 0, 10)).map((event) => event.type)).toEqual([
      'run.cancelled',
    ]);
    // A second request changes nothing.
    expect(await swarm.requestCancel(key)).toBe('recorded');
    expect((await store.head!(key))!.revision).toBe(1);
    const outcome = await (await swarm.resume(key)).result;
    expect(outcome.run.status).toBe('cancelled');
  });

  it('records the request without a lease provider too', async () => {
    const time = manualClock();
    const store = createInMemorySwarmStore();
    await store.create(interrupted(), []);
    const swarm = swarmOn({
      store,
      clock: time.clock,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    expect(await swarm.requestCancel(key)).toBe('recorded');
    expect((await store.head!(key))!.cancelRequested).toBe(true);
  });

  it('cancels a run this process drives', async () => {
    const time = manualClock();
    const store = createInMemorySwarmStore();
    const calls = { count: 0 };
    const swarm = swarmOn({
      store,
      clock: time.clock,
      owner: 'a',
      work: slow(gate().promise, calls),
    });
    const handle = await swarm.run({ ...key, tasks });
    await until(() => calls.count === 1);
    expect(await swarm.requestCancel(key)).toBe('signalled');
    expect((await handle.result).run.status).toBe('cancelled');
  });

  it('signals the lease holder in another process, which cancels on its next beat', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const calls = { count: 0 };
    const a = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(gate().promise, calls),
    });
    const handle = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    const b = swarmOn({
      store: connection(store),
      clock: time.clock,
      provider,
      owner: 'b',
      work: slow(Promise.resolve(), calls),
    });
    expect(await b.requestCancel(key)).toBe('signalled');
    expect((await store.head!(key))!.cancelRequested).toBe(false);
    await time.advance(1_000);
    const outcome = await handle.result;
    expect(outcome.run.status).toBe('cancelled');
    expect(outcome.tasks[0]?.status).toBe('cancelled');
  });

  it('cancels a run whose signalled holder crashed once another executor takes it over', async () => {
    const time = manualClock();
    const frozen = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const calls = { count: 0 };
    // A crashes mid-task: its clock stands still, so it never renews again.
    const a = swarmOn({
      store,
      clock: frozen.clock,
      provider,
      owner: 'a',
      work: slow(gate().promise, calls),
    });
    const zombie = await a.run({ ...key, tasks });
    await until(() => calls.count === 1);
    const b = swarmOn({
      store: connection(store),
      clock: time.clock,
      provider,
      owner: 'b',
      work: slow(Promise.resolve(), calls),
    });
    // A's lease is still valid, so the request goes to A, which never reads it.
    expect(await b.requestCancel(key)).toBe('signalled');
    await time.advance(10_000);
    const outcome = await (await b.resume(key)).result;
    expect(outcome.run).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(outcome.tasks[0]?.status).toBe('cancelled');
    // B never ran the task again.
    expect(calls.count).toBe(1);
    await frozen.advance(1_000);
    await expect(zombie.result).rejects.toMatchObject({ code: 'lost' });
  });

  it('turns a settle into a cancellation when a cancel arrives before it', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls = { count: 0 };
    const a = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(release.promise, calls),
    });
    const handle = await a.run({
      ...key,
      tasks: [
        { id: 'a', reducer: 'work' },
        { id: 'b', reducer: 'work', dependsOn: ['a'] },
      ],
    });
    await until(() => calls.count === 1);
    const drained = handle.drain();
    const b = swarmOn({
      store: connection(store),
      clock: time.clock,
      provider,
      owner: 'b',
      work: slow(Promise.resolve(), calls),
    });
    expect(await b.requestCancel(key)).toBe('signalled');
    // A settles before its next heartbeat would have delivered the cancel.
    release.resolve();
    const outcome = await drained;
    expect(outcome.run).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(outcome.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['a', 'completed'],
      ['b', 'cancelled'],
    ]);
    expect(calls.count).toBe(1);
  });

  it('applies a cancel that reached the holder after its last renewal on the next resume', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    await store.create(stored('suspended', { status: 'pending', attempt: 0 }), []);
    await queueCancel(provider, 'released', time);
    const calls = { count: 0 };
    const swarm = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(Promise.resolve(), calls),
    });
    const outcome = await (await swarm.resume(key)).result;
    expect(outcome.run).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(outcome.tasks[0]?.status).toBe('cancelled');
    expect(calls.count).toBe(0);
    expect((await store.readEvents(key, 0, 10)).map((event) => event.type)).toEqual([
      'run.resumed',
      'run.cancelled',
      'task.cancelled',
      'run.settled',
    ]);
  });

  it('does not relabel a finished run with a cancel that lost the race to its end', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    await store.create(stored('completed', { status: 'completed', result: { output: 1 } }), []);
    await queueCancel(provider, 'released', time);
    const swarm = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    const outcome = await (await swarm.resume(key)).result;
    expect(outcome.run).toMatchObject({ status: 'completed', cancelRequested: false });
    // The stale request was delivered and dropped, not left for the next holder.
    const next = (await provider.acquire({ key: leaseKey, owner: 'x', ttlMs: 3_000 }))!;
    expect(await provider.renew(next, 3_000)).toMatchObject({ held: true, signals: [] });
  });

  it('keeps a queued cancel in place when a resume fails to commit its claim', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    await store.create(interrupted(), []);
    await queueCancel(provider, 'lapsed', time);
    let refused = false;
    const flaky: SwarmStore = {
      ...store,
      async commit(change) {
        if (refused) return store.commit(change);
        refused = true;
        throw new SwarmConflictError();
      },
    };
    const swarm = swarmOn({
      store: flaky,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    await expect(swarm.resume(key)).rejects.toBeInstanceOf(SwarmConflictError);
    // The next claim still receives it.
    const outcome = await (await swarm.resume(key)).result;
    expect(outcome.run).toMatchObject({ status: 'cancelled', cancelRequested: true });
  });

  it('starts a new run clean even when its key still queues a cancel', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    await queueCancel(provider, 'released', time);
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls = { count: 0 };
    const swarm = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(release.promise, calls),
    });
    const handle = await swarm.run({ ...key, tasks });
    await until(() => calls.count === 1);
    // The first heartbeat has nothing to deliver: the cancel predated the run.
    await time.advance(1_000);
    release.resolve();
    expect((await handle.result).run).toMatchObject({
      status: 'completed',
      cancelRequested: false,
    });
  });

  it('leaves an existing run its queued cancel when run() finds the key taken', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    await store.create(interrupted(), []);
    await queueCancel(provider, 'lapsed', time);
    const swarm = swarmOn({
      store,
      clock: time.clock,
      provider,
      owner: 'a',
      work: slow(Promise.resolve(), { count: 0 }),
    });
    await expect(swarm.run({ ...key, tasks })).rejects.toBeInstanceOf(SwarmConflictError);
    const outcome = await (await swarm.resume(key)).result;
    expect(outcome.run).toMatchObject({ status: 'cancelled', cancelRequested: true });
  });
});
