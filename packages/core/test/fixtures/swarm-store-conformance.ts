import { describe, expect, it } from 'vitest';
import type {
  SwarmChannelPost,
  SwarmCommit,
  SwarmRunRecord,
  SwarmSnapshot,
  SwarmStore,
  SwarmTaskRecord,
} from '../../src/types/swarm';

/** A version 1 (fixed DAG) run with one pending reducer task. */
export function initialSnapshot(scope = 'a'): SwarmSnapshot {
  return {
    run: {
      kind: 'deuz-swarm',
      version: 1,
      scope,
      runId: 'same',
      definitionVersion: '1',
      status: 'running',
      revision: 0,
      lastSequence: 0,
      createdAt: 1,
      updatedAt: 1,
      cancelRequested: false,
    },
    tasks: [
      { task: { id: 'a', reducer: 'sum' }, bindingVersion: '1', status: 'pending', attempt: 0 },
    ],
  };
}

/** A version 2 (dynamic) run whose task 'a' is on its first attempt. */
function dynamicSnapshot(): SwarmSnapshot {
  const base = initialSnapshot();
  return {
    run: {
      ...base.run,
      version: 2,
      dynamic: { maxTasks: 4, maxSpawnDepth: 1, maxSpawnPerTask: 4 },
    },
    tasks: [
      { task: { id: 'a', reducer: 'sum' }, bindingVersion: '1', status: 'running', attempt: 1 },
    ],
  };
}

const finished = (snapshot: SwarmSnapshot): SwarmTaskRecord => ({
  ...snapshot.tasks[0]!,
  status: 'completed',
  result: { output: 1 },
});

const child = (id: string, extra: Partial<SwarmTaskRecord> = {}): SwarmTaskRecord => ({
  task: { id, reducer: 'sum' },
  bindingVersion: '1',
  status: 'pending',
  attempt: 0,
  spawnedBy: { taskId: 'a', attempt: 1, on: 'completed' },
  depth: 1,
  ...extra,
});

/**
 * The durable contract every swarm store implements. `spawn` enables the 2.2
 * dynamic-task contracts for stores that declare the capability.
 */
export function swarmStoreContracts(
  name: string,
  make: () => SwarmStore,
  options: { spawn?: boolean; channels?: boolean; list?: boolean } = {},
): void {
  describe(name, () => {
    it('atomically rolls back invalid multi-task writes and event publication', async () => {
      const store = make();
      const snapshot = initialSnapshot();
      await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
      await expect(
        store.commit({
          ...snapshot.run,
          expectedRevision: 0,
          tasks: [
            { ...snapshot.tasks[0]!, status: 'completed', result: { output: 4 } },
            { ...snapshot.tasks[0]!, task: { id: 'unknown', reducer: 'sum' } },
          ],
          events: [{ type: 'task.completed', taskId: 'a', timestamp: 2 }],
        }),
      ).rejects.toThrow('fixed swarm');
      expect((await store.load(snapshot.run))?.tasks[0]?.status).toBe('pending');
      expect((await store.readEvents(snapshot.run, 0, 10)).map((event) => event.type)).toEqual([
        'run.started',
      ]);
      expect((await store.load(snapshot.run))?.run.revision).toBe(0);
    });

    it('checks revision, isolates scopes, returns copies, and roundtrips bytes', async () => {
      const store = make();
      const a = initialSnapshot();
      const b = initialSnapshot('b');
      await store.create(a, []);
      await store.create(b, []);
      await store.commit({
        ...a.run,
        expectedRevision: 0,
        tasks: [
          { ...a.tasks[0]!, status: 'completed', result: { output: new Uint8Array([0, 255]) } },
        ],
      });
      await expect(store.commit({ ...a.run, expectedRevision: 0 })).rejects.toThrow('conflict');
      expect((await store.load(b.run))?.tasks[0]?.status).toBe('pending');
      const copy = await store.load(a.run);
      expect(copy?.tasks[0]?.result?.output).toEqual(new Uint8Array([0, 255]));
      copy!.tasks[0]!.status = 'failed';
      expect((await store.load(a.run))?.tasks[0]?.status).toBe('completed');
    });

    it('reads the run record alone through head()', async () => {
      const store = make();
      const snapshot = initialSnapshot();
      await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
      await store.commit({
        ...snapshot.run,
        expectedRevision: 0,
        tasks: [{ ...snapshot.tasks[0]!, status: 'running', attempt: 1 }],
        events: [{ type: 'task.started', taskId: 'a', timestamp: 2 }],
      });
      const head = await store.head!(snapshot.run);
      expect(head).toEqual((await store.load(snapshot.run))?.run);
      expect(head).toMatchObject({ revision: 1, lastSequence: 2 });
      head!.status = 'cancelled';
      expect((await store.head!(snapshot.run))?.status).toBe('running');
      expect(await store.head!({ scope: 'none', runId: 'none' })).toBeUndefined();
    });

    if (options.channels) {
      const post = (entryId: string, extra: Partial<SwarmChannelPost> = {}): SwarmChannelPost => ({
        channel: 'euler',
        entryId,
        taskId: 'a',
        attempt: 1,
        text: `note ${entryId}`,
        at: 3,
        ...extra,
      });

      it('declares the channels capability', () => {
        expect(make().capabilities).toContain('channels');
      });

      it('orders posts per channel, pages them and journals only new entries', async () => {
        const store = make();
        const snapshot = initialSnapshot();
        await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
        await store.commit({
          ...snapshot.run,
          expectedRevision: 0,
          posts: [post('p1'), post('p2', { data: { ok: true } }), post('q1', { channel: 'ns' })],
        });
        // An identical replay of an earlier post is a no-op.
        await store.commit({ ...snapshot.run, expectedRevision: 1, posts: [post('p1')] });
        const euler = await store.readChannel!(snapshot.run, 'euler', 0, 10);
        expect(euler.map((entry) => [entry.sequence, entry.entryId, entry.text])).toEqual([
          [1, 'p1', 'note p1'],
          [2, 'p2', 'note p2'],
        ]);
        expect(euler[1]?.data).toEqual({ ok: true });
        expect(
          (await store.readChannel!(snapshot.run, 'euler', 1, 10)).map((entry) => entry.entryId),
        ).toEqual(['p2']);
        expect(
          (await store.readChannel!(snapshot.run, 'euler', 0, 1)).map((entry) => entry.entryId),
        ).toEqual(['p1']);
        expect(
          (await store.readChannel!(snapshot.run, 'ns', 0, 10)).map((entry) => entry.sequence),
        ).toEqual([1]);
        expect(await store.readChannel!({ scope: 'none', runId: 'same' }, 'euler', 0, 10)).toEqual(
          [],
        );
        const events = await store.readEvents(snapshot.run, 0, 10);
        expect(events.map((event) => [event.type, event.detail])).toEqual([
          ['run.started', undefined],
          ['channel.posted', 'euler'],
          ['channel.posted', 'euler'],
          ['channel.posted', 'ns'],
        ]);
        expect((await store.load(snapshot.run))?.run.lastSequence).toBe(4);
      });

      it('rejects a conflicting repeat or an invalid post without writing anything', async () => {
        const cases: [string, SwarmChannelPost][] = [
          ['conflicting repeat', post('p1', { text: 'different' })],
          ['bad channel', post('x', { channel: 'bad channel!' })],
          ['unknown task', post('y', { taskId: 'nope' })],
          ['empty text', post('z', { text: '' })],
        ];
        for (const [label, bad] of cases) {
          const store = make();
          const snapshot = initialSnapshot();
          await store.create(snapshot, []);
          await store.commit({ ...snapshot.run, expectedRevision: 0, posts: [post('p1')] });
          await expect(
            store.commit({
              ...snapshot.run,
              expectedRevision: 1,
              tasks: [{ ...snapshot.tasks[0]!, status: 'running', attempt: 1 }],
              posts: [post('ok'), bad],
            }),
            label,
          ).rejects.toThrow();
          expect(
            (await store.readChannel!(snapshot.run, 'euler', 0, 10)).map((entry) => entry.entryId),
            label,
          ).toEqual(['p1']);
          const after = await store.load(snapshot.run);
          expect(after?.tasks[0]?.status, label).toBe('pending');
          expect(after?.run.revision, label).toBe(1);
        }
      });
    }

    if (options.list) {
      const at = (scope: string, runId: string, updatedAt: number): SwarmSnapshot => {
        const snapshot = initialSnapshot(scope);
        return { ...snapshot, run: { ...snapshot.run, runId, createdAt: updatedAt, updatedAt } };
      };
      const ids = (runs: readonly { scope: string; runId: string }[]) =>
        runs.map((run) => `${run.scope}/${run.runId}`);

      it('declares the list capability', () => {
        expect(make().capabilities).toContain('list');
      });

      it('lists runs by status and scope, ordered by updatedAt then scope and runId', async () => {
        const store = make();
        await store.create(at('a', 'r1', 5), []);
        await store.create(at('b', 'r1', 3), []);
        await store.create(at('a', 'r2', 3), []);
        await store.create(at('a', 'r3', 9), []);
        await store.commit({
          scope: 'a',
          runId: 'r3',
          expectedRevision: 0,
          run: { status: 'suspended', updatedAt: 1 },
        });
        expect(ids(await store.listRuns!({ limit: 10 }))).toEqual(['a/r3', 'a/r2', 'b/r1', 'a/r1']);
        expect(ids(await store.listRuns!({ status: 'running', limit: 10 }))).toEqual([
          'a/r2',
          'b/r1',
          'a/r1',
        ]);
        expect(ids(await store.listRuns!({ scope: 'a', limit: 10 }))).toEqual([
          'a/r3',
          'a/r2',
          'a/r1',
        ]);
        expect(ids(await store.listRuns!({ scope: 'a', status: 'running', limit: 1 }))).toEqual([
          'a/r2',
        ]);
        expect(await store.listRuns!({ status: 'completed', limit: 10 })).toEqual([]);
        const [first] = await store.listRuns!({ limit: 1 });
        expect(first).toEqual((await store.load({ scope: 'a', runId: 'r3' }))?.run);
        first!.status = 'cancelled';
        expect((await store.listRuns!({ limit: 1 }))[0]?.status).toBe('suspended');
        await expect(store.listRuns!({ limit: 0 })).rejects.toThrow();
        await expect(store.listRuns!({ limit: 1001 })).rejects.toThrow();
      });

      it('pages with an exclusive after cursor in the listing order', async () => {
        const store = make();
        await store.create(at('a', 'r1', 5), []);
        await store.create(at('b', 'r1', 3), []);
        await store.create(at('a', 'r2', 3), []);
        await store.create(at('a', 'r3', 5), []);
        await store.create(at('c', 'r0', 7), []);
        await store.commit({
          scope: 'c',
          runId: 'r0',
          expectedRevision: 0,
          run: { status: 'suspended' },
        });
        const pages: string[][] = [];
        let after: SwarmRunRecord | undefined;
        // Bounded, so a store that ignores the cursor fails instead of looping.
        for (let round = 0; round < 5; round++) {
          const page = await store.listRuns!({ limit: 2, ...(after ? { after } : {}) });
          pages.push(ids(page));
          if (page.length < 2) break;
          after = page.at(-1);
        }
        expect(pages).toEqual([['a/r2', 'b/r1'], ['a/r1', 'a/r3'], ['c/r0']]);
        // Strictly after the cursor: ties on updatedAt fall back to scope, then runId.
        const from = (updatedAt: number, scope: string, runId: string) =>
          store.listRuns!({ limit: 10, after: { updatedAt, scope, runId } });
        expect(ids(await from(3, 'a', 'r2'))).toEqual(['b/r1', 'a/r1', 'a/r3', 'c/r0']);
        expect(ids(await from(3, 'b', 'r1'))).toEqual(['a/r1', 'a/r3', 'c/r0']);
        expect(ids(await from(5, 'a', 'r1'))).toEqual(['a/r3', 'c/r0']);
        expect(ids(await from(4, 'z', ''))).toEqual(['a/r1', 'a/r3', 'c/r0']);
        expect(await from(7, 'c', 'r0')).toEqual([]);
        // The cursor combines with the filters.
        expect(
          ids(
            await store.listRuns!({
              scope: 'a',
              status: 'running',
              limit: 10,
              after: { updatedAt: 3, scope: 'a', runId: 'r2' },
            }),
          ),
        ).toEqual(['a/r1', 'a/r3']);
        expect(
          ids(
            await store.listRuns!({
              status: 'running',
              limit: 10,
              after: { updatedAt: 5, scope: 'a', runId: 'r3' },
            }),
          ),
        ).toEqual([]);
        await expect(
          store.listRuns!({ limit: 1, after: { updatedAt: Number.NaN, scope: 'a', runId: 'r' } }),
        ).rejects.toThrow();
        await expect(
          store.listRuns!({
            limit: 1,
            after: { updatedAt: 1, scope: 7, runId: 'r' } as unknown as SwarmRunRecord,
          }),
        ).rejects.toThrow();
      });
    }

    if (!options.spawn) return;

    it('declares the spawn capability', () => {
      expect(make().capabilities).toContain('spawn');
    });

    it('commits spawned tasks atomically with the parent terminal state', async () => {
      const store = make();
      const snapshot = dynamicSnapshot();
      await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
      await store.commit({
        ...snapshot.run,
        expectedRevision: 0,
        tasks: [finished(snapshot)],
        spawn: [
          child('a/x'),
          child('a/y', { task: { id: 'a/y', reducer: 'sum', dependsOn: ['a/x'] } }),
        ],
        events: [
          { type: 'task.completed', taskId: 'a', timestamp: 2 },
          { type: 'task.spawned', taskId: 'a/x', detail: 'a', timestamp: 2 },
          { type: 'task.spawned', taskId: 'a/y', detail: 'a', timestamp: 2 },
        ],
      });
      const loaded = await store.load(snapshot.run);
      expect(loaded?.tasks.map((task) => task.task.id)).toEqual(['a', 'a/x', 'a/y']);
      expect(loaded?.tasks[1]).toMatchObject({
        status: 'pending',
        depth: 1,
        spawnedBy: { taskId: 'a', attempt: 1, on: 'completed' },
      });
      expect((await store.readEvents(snapshot.run, 0, 10)).map((event) => event.type)).toEqual([
        'run.started',
        'task.completed',
        'task.spawned',
        'task.spawned',
      ]);
      // A spawned task is an ordinary task afterwards.
      await store.commit({
        ...snapshot.run,
        expectedRevision: 1,
        tasks: [{ ...loaded!.tasks[1]!, status: 'running', attempt: 1 }],
      });
      expect((await store.load(snapshot.run))?.tasks[1]?.status).toBe('running');
    });

    it('rejects an invalid spawn without writing anything', async () => {
      const cases: [string, (snapshot: SwarmSnapshot) => Partial<SwarmCommit>][] = [
        ['parent not terminal', (s) => ({ tasks: [s.tasks[0]!], spawn: [child('a/x')] })],
        ['parent missing', () => ({ spawn: [child('a/x')] })],
        ['duplicate id', (s) => ({ tasks: [finished(s)], spawn: [child('a/x'), child('a/x')] })],
        [
          'missing dependency',
          (s) => ({
            tasks: [finished(s)],
            spawn: [child('a/x', { task: { id: 'a/x', reducer: 'sum', dependsOn: ['nope'] } })],
          }),
        ],
        [
          'cycle',
          (s) => ({
            tasks: [finished(s)],
            spawn: [
              child('a/x', { task: { id: 'a/x', reducer: 'sum', dependsOn: ['a/y'] } }),
              child('a/y', { task: { id: 'a/y', reducer: 'sum', dependsOn: ['a/x'] } }),
            ],
          }),
        ],
        [
          'over maxTasks',
          (s) => ({
            tasks: [finished(s)],
            spawn: ['a/1', 'a/2', 'a/3', 'a/4'].map((id) => child(id)),
          }),
        ],
        ['over depth', (s) => ({ tasks: [finished(s)], spawn: [child('a/x', { depth: 2 })] })],
        ['outside namespace', (s) => ({ tasks: [finished(s)], spawn: [child('b/x')] })],
        [
          'not pending',
          (s) => ({ tasks: [finished(s)], spawn: [child('a/x', { status: 'running' })] }),
        ],
        [
          'wrong parent attempt',
          (s) => ({
            tasks: [finished(s)],
            spawn: [child('a/x', { spawnedBy: { taskId: 'a', attempt: 2, on: 'completed' } })],
          }),
        ],
        [
          'wrong parent outcome',
          (s) => ({
            tasks: [finished(s)],
            spawn: [child('a/x', { spawnedBy: { taskId: 'a', attempt: 1, on: 'failed' } })],
          }),
        ],
      ];
      for (const [label, change] of cases) {
        const store = make();
        const snapshot = dynamicSnapshot();
        await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
        await expect(
          store.commit({
            ...snapshot.run,
            expectedRevision: 0,
            events: [{ type: 'task.completed', taskId: 'a', timestamp: 2 }],
            ...change(snapshot),
          }),
          label,
        ).rejects.toThrow();
        const after = await store.load(snapshot.run);
        expect(
          after?.tasks.map((task) => [task.task.id, task.status]),
          label,
        ).toEqual([['a', 'running']]);
        expect(after?.run.revision, label).toBe(0);
        expect(await store.readEvents(snapshot.run, 0, 10), label).toHaveLength(1);
      }
    });

    it('refuses to spawn from a version 1 run', async () => {
      const store = make();
      const snapshot = initialSnapshot();
      await store.create(snapshot, []);
      await expect(
        store.commit({
          ...snapshot.run,
          expectedRevision: 0,
          tasks: [
            { ...snapshot.tasks[0]!, status: 'completed', attempt: 1, result: { output: 1 } },
          ],
          spawn: [child('a/x')],
        }),
      ).rejects.toThrow(/dynamic/);
      expect((await store.load(snapshot.run))?.tasks).toHaveLength(1);
    });
  });
}
