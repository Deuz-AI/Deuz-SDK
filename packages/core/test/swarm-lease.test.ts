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
import type { SwarmReducerBinding, SwarmSnapshot, SwarmStore, SwarmTask } from '../src/types/swarm';
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
});
