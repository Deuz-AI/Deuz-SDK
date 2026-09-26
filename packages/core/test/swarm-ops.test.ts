import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemorySwarmStore, createSwarm, SwarmLeaseError } from '../src/swarm';
import { createInMemoryLeaseProvider } from '../src/ops';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createSqliteSwarmStore } from '../src/node/swarm-sqlite';
import { swarmKey } from '../src/swarm/store';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import type { Clock } from '../src/types/deps';
import type { LeaseProvider } from '../src/types/lease';
import type { SwarmReducerBinding, SwarmSnapshot, SwarmStore, SwarmTask } from '../src/types/swarm';
import { manualClock } from './fixtures/manual-clock';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

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
const leaseKey = (runId = 'run') => `swarm:${swarmKey({ scope: 'tenant', runId })}`;

/** 'slow' waits for its gate (or an abort); 'fast' returns at once. */
function reducers(release: Promise<void>, calls: string[]): Record<string, SwarmReducerBinding> {
  return {
    slow: {
      async execute(_results, context) {
        calls.push(context.taskId);
        await new Promise<void>((resolve, reject) => {
          void release.then(resolve);
          context.signal.addEventListener('abort', () => reject(context.signal.reason as Error), {
            once: true,
          });
        });
        return context.taskId;
      },
    },
    fast: {
      execute(_results, context) {
        calls.push(context.taskId);
        return context.taskId;
      },
    },
  };
}

function swarmOn(input: {
  store: SwarmStore;
  clock: Clock;
  provider?: LeaseProvider;
  owner?: string;
  release: Promise<void>;
  calls: string[];
  concurrency?: number;
  definitionVersion?: string;
}) {
  return createSwarm({
    agents: {},
    store: input.store,
    reducers: reducers(input.release, input.calls),
    concurrency: input.concurrency ?? 1,
    deps: { clock: input.clock },
    ...(input.definitionVersion ? { definitionVersion: input.definitionVersion } : {}),
    ...(input.provider
      ? { lease: { provider: input.provider, owner: input.owner ?? 'a', ttlMs: 3_000 } }
      : {}),
  });
}

/** A run whose executor crashed mid-task, as a store holds it. */
function crashed(runId: string, updatedAt: number, definitionVersion = '1'): SwarmSnapshot {
  return {
    run: {
      kind: 'deuz-swarm',
      version: 1,
      scope: 'tenant',
      runId,
      definitionVersion,
      status: 'running',
      revision: 0,
      lastSequence: 0,
      createdAt: updatedAt,
      updatedAt,
      cancelRequested: false,
    },
    tasks: [
      {
        task: { id: 'a', reducer: 'fast', replay: 'safe' },
        bindingVersion: '1',
        status: 'running',
        attempt: 1,
      },
    ],
  };
}

const drainTasks: SwarmTask[] = [
  { id: 'a', reducer: 'slow' },
  { id: 'b', reducer: 'fast' },
  { id: 'c', reducer: 'fast', dependsOn: ['b'] },
];

describe('swarm drain', () => {
  it('stops dispatch, lets in-flight work finish, and settles suspended', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls: string[] = [];
    const swarm = swarmOn({ store, clock: time.clock, provider, release: release.promise, calls });
    const handle = await swarm.run({ ...key, tasks: drainTasks });
    await until(() => calls.length === 1);
    const drained = handle.drain();
    release.resolve();
    const outcome = await drained;
    expect(outcome).toEqual(await handle.result);
    expect(outcome.run.status).toBe('suspended');
    expect(outcome.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ['a', 'completed'],
      ['b', 'pending'],
      ['c', 'pending'],
    ]);
    expect(calls).toEqual(['a']);
    const types = (await store.readEvents(key, 0, 100)).map((event) => event.type);
    expect(types.slice(-2)).toEqual(['run.drained', 'run.settled']);
    // The lease is free for whoever resumes it.
    const probe = await provider.acquire({ key: leaseKey(), owner: 'x', ttlMs: 1 });
    expect(probe).toBeDefined();
    await provider.release(probe!);
    const resumed = await swarm.resume(key);
    expect((await resumed.result).run.status).toBe('completed');
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('settles completed when nothing remains after the in-flight task', async () => {
    const time = manualClock();
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls: string[] = [];
    const swarm = swarmOn({ store, clock: time.clock, release: release.promise, calls });
    const handle = await swarm.run({ ...key, tasks: [{ id: 'a', reducer: 'slow' }] });
    await until(() => calls.length === 1);
    const drained = handle.drain();
    release.resolve();
    expect((await drained).run.status).toBe('completed');
    const events = await store.readEvents(key, 0, 100);
    expect(events.map((event) => event.type).slice(-2)).toEqual(['run.drained', 'run.settled']);
  });

  it('drains on a lease signal from another process', async () => {
    const time = manualClock();
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemorySwarmStore();
    const release = gate();
    const calls: string[] = [];
    const swarm = swarmOn({ store, clock: time.clock, provider, release: release.promise, calls });
    const handle = await swarm.run({ ...key, tasks: drainTasks });
    await until(() => calls.length === 1);
    expect(await provider.signal(leaseKey(), 'drain')).toBe(true);
    await time.advance(1_000);
    release.resolve();
    const outcome = await handle.result;
    expect(outcome.run.status).toBe('suspended');
    expect(calls).toEqual(['a']);
  });
});

describe('swarm recover', () => {
  it('requires a lease provider and a store that can list runs', async () => {
    const time = manualClock();
    const calls: string[] = [];
    const bare = swarmOn({
      store: createInMemorySwarmStore(),
      clock: time.clock,
      release: Promise.resolve(),
      calls,
    });
    await expect(bare.recover()).rejects.toThrow(/lease/);
    const { listRuns: _omit, ...unlisted } = createInMemorySwarmStore();
    const noList = swarmOn({
      store: { ...unlisted, capabilities: ['spawn', 'channels'] },
      clock: time.clock,
      provider: createInMemoryLeaseProvider({ clock: time.clock }),
      release: Promise.resolve(),
      calls,
    });
    await expect(noList.recover()).rejects.toThrow(/list/);
  });

  it('reports a run it cannot resume and still recovers the others', async () => {
    const time = manualClock();
    const store = createInMemorySwarmStore();
    // A rolling deploy: the middle run belongs to the previous definition.
    await store.create(crashed('r1', 1, 'v2'), []);
    await store.create(crashed('r2', 2, 'v1'), []);
    await store.create(crashed('r3', 3, 'v2'), []);
    const calls: string[] = [];
    const swarm = swarmOn({
      store,
      clock: time.clock,
      provider: createInMemoryLeaseProvider({ clock: time.clock }),
      release: Promise.resolve(),
      calls,
      definitionVersion: 'v2',
    });
    const { handles, failed } = await swarm.recover();
    expect(handles.map((handle) => handle.runId)).toEqual(['r1', 'r3']);
    expect(failed).toEqual([
      {
        key: { scope: 'tenant', runId: 'r2' },
        error: new Error('Swarm definition version mismatch'),
      },
    ]);
    for (const handle of handles) expect((await handle.result).run.status).toBe('completed');
    // The failed run is untouched and its lease is free for a v1 worker.
    expect(await store.head!({ scope: 'tenant', runId: 'r2' })).toMatchObject({
      status: 'running',
      revision: 0,
    });
  });

  it.skipIf(!DatabaseSync)(
    'takes over a crashed executor on one SQLite file and skips a run with a live holder',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'deuz-swarm-ops-'));
      cleanup.push(() =>
        rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
      );
      const path = join(directory, 'swarm.sqlite');
      const time = manualClock();
      const frozen = manualClock();
      const open = () => {
        const store = createSqliteSwarmStore({ path });
        const ops = createSqliteOpsStore({ path, clock: time.clock });
        cleanup.push(() => store.close());
        cleanup.push(() => ops.close());
        return { store, leases: ops.leases };
      };
      const tasks: SwarmTask[] = [
        { id: 'a', reducer: 'slow', replay: 'safe' },
        { id: 'b', reducer: 'fast', dependsOn: ['a'] },
      ];
      // Process A crashes mid-task: its clock stops, so it never renews again.
      const stuck = gate();
      const callsA: string[] = [];
      const pa = open();
      const a = swarmOn({
        store: pa.store,
        clock: frozen.clock,
        provider: pa.leases,
        owner: 'a',
        release: stuck.promise,
        calls: callsA,
      });
      const crashed = await a.run({ ...key, tasks });
      // Process C is alive and keeps renewing its own run.
      const liveGate = gate();
      const callsC: string[] = [];
      const pc = open();
      const c = swarmOn({
        store: pc.store,
        clock: time.clock,
        provider: pc.leases,
        owner: 'c',
        release: liveGate.promise,
        calls: callsC,
      });
      const live = await c.run({ scope: 'tenant', runId: 'live', tasks });
      await until(() => callsA.length === 1 && callsC.length === 1);
      await time.advance(10_000);

      const callsB: string[] = [];
      const pb = open();
      const b = swarmOn({
        store: pb.store,
        clock: time.clock,
        provider: pb.leases,
        owner: 'b',
        release: Promise.resolve(),
        calls: callsB,
      });
      const recovered = await b.recover({ scope: 'tenant' });
      expect(recovered.failed).toEqual([]);
      expect(recovered.handles.map((handle) => handle.runId)).toEqual(['run']);
      const outcome = await recovered.handles[0]!.result;
      expect(outcome.run.status).toBe('completed');
      expect(callsB).toEqual(['a', 'b']);
      // Nothing else to recover: one run is done, the other has a live holder.
      expect(await b.recover()).toEqual({ handles: [], failed: [] });

      const settled = await pb.store.head!(key);
      await frozen.advance(1_000);
      stuck.resolve();
      await expect(crashed.result).rejects.toBeInstanceOf(SwarmLeaseError);
      expect(await pb.store.head!(key)).toEqual(settled);

      liveGate.resolve();
      expect((await live.result).run.status).toBe('completed');
    },
  );
});
