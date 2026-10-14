import { describe, expect, it } from 'vitest';
import { OperationConflictError } from '../../src/errors';
import type {
  ProcessOperationRecord,
  ProcessOperationStore,
  ProcessState,
} from '../../src/compute/docker/types';

export interface ProcessOperationStoreHarness {
  store: ProcessOperationStore;
  /** Moves the store's clock forward. */
  advance(ms: number): void;
  now(): number;
}

const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;

type NewRecord = Parameters<ProcessOperationStore['create']>[0];

export function newRecord(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    operationId: 'op-1',
    scope: 'tenant-a',
    state: 'recorded',
    durableTimeout: false,
    requestDigest: DIGEST_A,
    imageId: `sha256:${'c'.repeat(64)}`,
    request: { command: ['echo', 'hi'], envKeys: ['TOKEN'], files: [{ path: 'a.txt', size: 3 }] },
    ...overrides,
  };
}

/**
 * The ProcessOperationStore contract (2.4, spec §3.3): an idempotent create
 * keyed by (scope, operationId) and fenced by the request digest, a
 * compare-and-set update, a scoped and paged list, and retention that only
 * ever drops terminal records. Shared by the in-memory and SQLite stores.
 */
export function processOperationStoreContracts(
  name: string,
  make: () => Promise<ProcessOperationStoreHarness>,
): void {
  describe(name, () => {
    it('records a new operation at revision 1 with store-managed timestamps', async () => {
      const { store, now } = await make();
      const created = await store.create(newRecord());
      expect(created.status).toBe('created');
      expect(created.record).toMatchObject({
        operationId: 'op-1',
        scope: 'tenant-a',
        state: 'recorded',
        revision: 1,
        durableTimeout: false,
        requestDigest: DIGEST_A,
        createdAt: now(),
        updatedAt: now(),
        request: {
          command: ['echo', 'hi'],
          envKeys: ['TOKEN'],
          files: [{ path: 'a.txt', size: 3 }],
        },
      });
      expect(await store.get('tenant-a', 'op-1')).toEqual(created.record);
    });

    it('returns the stored record for the same id and digest, untouched', async () => {
      const { store, advance } = await make();
      const first = await store.create(newRecord());
      await store.update(
        'tenant-a',
        'op-1',
        { state: 'created', containerId: 'c1' },
        {
          expectedRevision: 1,
        },
      );
      advance(10);
      const again = await store.create(newRecord());
      expect(again.status).toBe('existing');
      expect(again.record).toMatchObject({ state: 'created', containerId: 'c1', revision: 2 });
      expect(again.record.createdAt).toBe(first.record.createdAt);
    });

    it("refuses the same id with another request: OperationConflictError, subsystem 'process'", async () => {
      const { store } = await make();
      await store.create(newRecord());
      const error = await store
        .create(newRecord({ requestDigest: DIGEST_B }))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OperationConflictError);
      expect(error).toMatchObject({
        code: 'operation_conflict',
        subsystem: 'process',
        operationId: 'op-1',
        storedDigest: DIGEST_A,
        requestDigest: DIGEST_B,
      });
      expect((await store.get('tenant-a', 'op-1'))!.requestDigest).toBe(DIGEST_A);
    });

    it('keys operations by scope: the same id in two scopes are two operations', async () => {
      const { store } = await make();
      await store.create(newRecord());
      const other = await store.create(newRecord({ scope: 'tenant-b', requestDigest: DIGEST_B }));
      expect(other.status).toBe('created');
      expect(await store.get('tenant-b', 'op-1')).toMatchObject({ requestDigest: DIGEST_B });
      expect(await store.get('tenant-c', 'op-1')).toBeUndefined();
    });

    it('updates only at the expected revision and reports the current record on conflict', async () => {
      const { store, advance, now } = await make();
      await store.create(newRecord());
      advance(5);
      const ok = await store.update(
        'tenant-a',
        'op-1',
        { state: 'created', containerId: 'c1' },
        { expectedRevision: 1 },
      );
      expect(ok.status).toBe('committed');
      if (ok.status !== 'committed') return;
      expect(ok.record).toMatchObject({ state: 'created', containerId: 'c1', revision: 2 });
      expect(ok.record.updatedAt).toBe(now());
      expect(ok.record.createdAt).toBe(now() - 5);

      const stale = await store.update(
        'tenant-a',
        'op-1',
        { state: 'staged' },
        {
          expectedRevision: 1,
        },
      );
      expect(stale).toEqual({ status: 'conflict', record: ok.record });
      expect(await store.get('tenant-a', 'op-1')).toEqual(ok.record);

      const missing = await store.update(
        'tenant-a',
        'nope',
        { state: 'staged' },
        {
          expectedRevision: 1,
        },
      );
      expect(missing.status).toBe('conflict');
      expect(missing.record).toBeUndefined();
    });

    it('clears a field set to undefined and keeps operationId, scope and createdAt fixed', async () => {
      const { store } = await make();
      const { record } = await store.create(
        newRecord({ error: { name: 'Error', message: 'boom', code: 'docker_failed' } }),
      );
      const result = await store.update(
        'tenant-a',
        'op-1',
        {
          error: undefined,
          exitCode: 0,
          output: { stdout: 'ok', stderr: '', truncated: { stdout: false, stderr: true } },
          createdAt: 1,
        } as Partial<ProcessOperationRecord>,
        { expectedRevision: 1 },
      );
      expect(result.status).toBe('committed');
      const stored = (await store.get('tenant-a', 'op-1'))!;
      expect(stored).not.toHaveProperty('error');
      expect(stored).toMatchObject({
        operationId: 'op-1',
        scope: 'tenant-a',
        exitCode: 0,
        createdAt: record.createdAt,
        output: { stdout: 'ok', stderr: '', truncated: { stdout: false, stderr: true } },
      });
    });

    it('hands out copies: mutating a returned record changes nothing stored', async () => {
      const { store } = await make();
      const { record } = await store.create(newRecord());
      record.state = 'exited';
      record.request.command.push('mutated');
      const read = (await store.get('tenant-a', 'op-1'))!;
      expect(read.state).toBe('recorded');
      expect(read.request.command).toEqual(['echo', 'hi']);
      read.request.command.push('again');
      expect((await store.get('tenant-a', 'op-1'))!.request.command).toEqual(['echo', 'hi']);
    });

    it('lists by scope and state, oldest first, in pages', async () => {
      const { store, advance } = await make();
      const states: ProcessState[] = ['running', 'exited', 'running', 'failed', 'running'];
      for (let index = 0; index < states.length; index++) {
        await store.create(
          newRecord({ operationId: `op-${index}`, state: states[index]!, scope: 'tenant-a' }),
        );
        advance(1);
      }
      await store.create(newRecord({ operationId: 'other', scope: 'tenant-b', state: 'running' }));

      const all = await store.list();
      expect(all.records.map((r) => `${r.scope}/${r.operationId}`)).toEqual([
        'tenant-a/op-0',
        'tenant-a/op-1',
        'tenant-a/op-2',
        'tenant-a/op-3',
        'tenant-a/op-4',
        'tenant-b/other',
      ]);
      expect(all.cursor).toBeUndefined();

      const running = await store.list({ scope: 'tenant-a', states: ['running'] });
      expect(running.records.map((r) => r.operationId)).toEqual(['op-0', 'op-2', 'op-4']);

      const first = await store.list({ scope: 'tenant-a', limit: 2 });
      expect(first.records.map((r) => r.operationId)).toEqual(['op-0', 'op-1']);
      expect(first.cursor).toEqual(expect.any(String));
      const second = await store.list({ scope: 'tenant-a', limit: 2, cursor: first.cursor });
      expect(second.records.map((r) => r.operationId)).toEqual(['op-2', 'op-3']);
      const third = await store.list({ scope: 'tenant-a', limit: 2, cursor: second.cursor });
      expect(third.records.map((r) => r.operationId)).toEqual(['op-4']);
      expect(third.cursor).toBeUndefined();
    });

    it('orders records created in the same millisecond by scope, then id, in UTF-8 byte order', async () => {
      const { store } = await make();
      for (const operationId of ['b', '😀', 'a', 'ﬀ'])
        await store.create(newRecord({ operationId }));
      const { records } = await store.list({ limit: 3 });
      expect(records.map((r) => r.operationId)).toEqual(['a', 'b', 'ﬀ']);
    });

    it('rejects a limit outside 1..1000 and a malformed cursor', async () => {
      const { store } = await make();
      await expect(store.list({ limit: 0 })).rejects.toThrow(RangeError);
      await expect(store.list({ limit: 1001 })).rejects.toThrow(RangeError);
      await expect(store.list({ limit: 1.5 })).rejects.toThrow(RangeError);
      await expect(store.list({ cursor: 'not-a-cursor' })).rejects.toThrow(TypeError);
    });

    it('prunes only terminal records last updated before the cut', async () => {
      const { store, advance, now } = await make();
      const states: ProcessState[] = [
        'exited',
        'cancelled',
        'lost',
        'failed',
        'disposed',
        'running',
        'needs-reconcile',
        'cancel-requested',
        'start-dispatched',
      ];
      for (const state of states) await store.create(newRecord({ operationId: state, state }));
      advance(100);
      const cut = now();
      await store.create(newRecord({ operationId: 'late-exit', state: 'exited' }));
      expect(await store.prune({ terminalBefore: cut })).toBe(5);
      const left = (await store.list()).records.map((r) => r.operationId).sort();
      expect(left).toEqual(
        ['cancel-requested', 'late-exit', 'needs-reconcile', 'running', 'start-dispatched'].sort(),
      );
      expect(await store.prune({ terminalBefore: cut })).toBe(0);
    });
  });
}
