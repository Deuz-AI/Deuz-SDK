import { describe, expect, it } from 'vitest';
import type { RunRecord, RunStatus, RunStore } from '../../src/types/runtime';

const T0 = 1_700_000_000_000;

/** A run record with every optional field set, so a store that drops one fails. */
export function runRecord(runId: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    status: 'running',
    goal: `goal ${runId}`,
    stepIndex: 2,
    plan: {
      goal: 'ship it',
      tasks: [{ id: 't1', title: 'write', status: 'in_progress' }],
    },
    meta: { userId: 'u_1', tenant: 'acme', nested: { ok: true } },
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

const ids = (records: readonly RunRecord[]) => records.map((record) => record.runId).sort();

/**
 * The background-run metadata contract (1.8, `RunStore`), shared by the memory,
 * file, SQLite, Postgres and Redis stores. The listing order is not part of the
 * contract, so listings are compared as sets.
 */
export function runStoreContracts(
  name: string,
  make: () => Promise<{ store: RunStore; cleanup?: () => Promise<void> }>,
): void {
  const withStore = (test: (store: RunStore) => Promise<void>) => async () => {
    const { store, cleanup } = await make();
    try {
      await test(store);
    } finally {
      await cleanup?.();
    }
  };

  describe(`RunStore contract: ${name}`, () => {
    it(
      'round-trips a record and answers undefined for an unknown run',
      withStore(async (store) => {
        expect(await store.get('missing')).toBeUndefined();
        await store.create(runRecord('r1'));
        expect(await store.get('r1')).toEqual(runRecord('r1'));
      }),
    );

    it(
      'merges a patch, keeps the runId, and ignores the patch of an unknown run',
      withStore(async (store) => {
        await store.create(runRecord('r1'));
        await store.update('r1', { status: 'failed', error: 'boom', updatedAt: T0 + 5 });
        expect(await store.get('r1')).toEqual(
          runRecord('r1', { status: 'failed', error: 'boom', updatedAt: T0 + 5 }),
        );
        await store.update('r1', { runId: 'other' } as Partial<RunRecord>);
        expect((await store.get('r1'))?.runId).toBe('r1');
        expect(await store.get('other')).toBeUndefined();
        await store.update('never-created', { status: 'completed' });
        expect(await store.get('never-created')).toBeUndefined();
        expect(ids(await store.list())).toEqual(['r1']);
      }),
    );

    it(
      'lists every run, or the runs in one status as they are now',
      withStore(async (store) => {
        await store.create(runRecord('r1'));
        await store.create(runRecord('r2', { status: 'completed', createdAt: T0 + 1 }));
        await store.create(runRecord('r3', { status: 'suspended', createdAt: T0 + 2 }));
        expect(ids(await store.list())).toEqual(['r1', 'r2', 'r3']);
        expect(ids(await store.list({ status: 'completed' }))).toEqual(['r2']);
        expect(await store.list({ status: 'queued' })).toEqual([]);
        // A status change moves the run from one filtered listing to another.
        await store.update('r1', { status: 'completed' });
        expect(ids(await store.list({ status: 'completed' }))).toEqual(['r1', 'r2']);
        expect(await store.list({ status: 'running' })).toEqual([]);
        await store.update('r3', { status: 'running' });
        expect(ids(await store.list({ status: 'running' }))).toEqual(['r3']);
        expect(ids(await store.list({ status: 'suspended' }))).toEqual([]);
        expect(ids(await store.list({}))).toEqual(['r1', 'r2', 'r3']);
      }),
    );

    it(
      'replaces a record created again under the same runId',
      withStore(async (store) => {
        await store.create(runRecord('r1', { status: 'failed', error: 'first' }));
        await store.create(runRecord('r1', { status: 'queued', goal: 'again' }));
        const record = await store.get('r1');
        expect(record).toMatchObject({ status: 'queued', goal: 'again' });
        expect(ids(await store.list({ status: 'queued' }))).toEqual(['r1']);
        expect(await store.list({ status: 'failed' })).toEqual([]);
        expect(ids(await store.list())).toEqual(['r1']);
      }),
    );

    it(
      'deletes a run, and ignores the delete of an unknown one',
      withStore(async (store) => {
        if (!store.delete) throw new Error('This store cannot delete runs');
        await store.create(runRecord('r1'));
        await store.create(runRecord('r2', { status: 'completed' }));
        await store.delete('r1');
        await store.delete('never-created');
        expect(await store.get('r1')).toBeUndefined();
        expect(ids(await store.list())).toEqual(['r2']);
        expect(await store.list({ status: 'running' })).toEqual([]);
        // A deleted runId is free again.
        await store.create(runRecord('r1', { status: 'queued' }));
        expect(ids(await store.list({ status: 'queued' }))).toEqual(['r1']);
      }),
    );

    it(
      'keeps runIds apart that only differ in characters a key would escape',
      withStore(async (store) => {
        const runIds = ['a:b', 'a%3Ab', 'a b', 'ç/ş', 'r'];
        for (const [index, runId] of runIds.entries())
          await store.create(runRecord(runId, { createdAt: T0 + index }));
        for (const runId of runIds) expect((await store.get(runId))?.runId).toBe(runId);
        expect(ids(await store.list())).toEqual([...runIds].sort());
        const statuses: RunStatus[] = ['queued', 'running', 'suspended', 'completed', 'failed'];
        for (const status of statuses)
          expect(ids(await store.list({ status }))).toEqual(
            status === 'running' ? [...runIds].sort() : [],
          );
      }),
    );
  });
}
