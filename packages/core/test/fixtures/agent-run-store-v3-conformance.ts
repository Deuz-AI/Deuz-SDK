/**
 * The `AgentRunStoreV3` contract (2.4, spec §4.1 and §4.4), shared by the
 * in-memory, SQLite and Postgres stores:
 *
 * - envelopes go in and out as copies; a save commits only at the stored
 *   revision plus one (`RevisionConflictError`, subsystem `'run'`), and only
 *   a version 3 envelope (never a version 1 or 2 one: no downgrade);
 * - `list` pages like the 2.3 `AgentRunStore.list`;
 * - context package blobs are stored once by digest, checked against it, and
 *   `redactForgotten` redacts every blob holding a forgotten revision (also
 *   one put after the forget), marking the manifests that point to it;
 * - `prune({ terminalBefore })` deletes old terminal runs and the blobs only
 *   they used.
 *
 * `advance` moves the store's clock forward (or waits on a database clock),
 * `now` reads it.
 */
import { describe, expect, it } from 'vitest';
import { assertAgentRunStoreV3 } from '../../src/agent-run-v3';
import { contextPackageBlob, type ContextPackageBlob } from '../../src/agent-run-v3-context';
import { RevisionConflictError } from '../../src/errors';
import { sha256Digest } from '../../src/internal/digest';
import type { AgentResult } from '../../src/types/agent-run';
import type {
  AgentRunContextStepV3,
  AgentRunEnvelopeV3,
  AgentRunStoreV3,
} from '../../src/types/agent-run-v3';
import { contextPackage, envelopeV3 } from './agent-run-v3';
import { createWorkingMemoryFixture } from './working-memory';

export interface AgentRunStoreV3Harness {
  store: AgentRunStoreV3;
  advance(ms: number): Promise<void>;
  /** The store's time, epoch ms. */
  now(): Promise<number>;
  cleanup?(): Promise<void>;
}

/** A stored result of the given status. */
export function outcomeV3(
  runId: string,
  status: AgentResult<unknown>['status'],
): AgentResult<unknown> {
  const base = { runId, text: '', messages: [], usage: envelopeV3(runId, 1).usage, modelSteps: 1 };
  if (status === 'completed') return { ...base, status, output: 'done' };
  if (status === 'suspended')
    return { ...base, status, pendingApprovals: [], pendingClientCalls: [] };
  if (status === 'stopped') return { ...base, status, reason: 'aborted' };
  return { ...base, status, error: { name: 'Error', message: 'boom' } };
}

/** A step pointing to `blob`, with the manifest of `contextPackage(step, marker)`. */
export function stepFor(
  step: number,
  blob: ContextPackageBlob,
  marker = 'x',
): AgentRunContextStepV3 {
  return {
    step,
    manifest: contextPackage(step, marker).manifest,
    blob: { digest: blob.digest, bytes: blob.bytes },
  };
}

/** An envelope whose context steps point to `blobs`. */
export function withBlobs(
  runId: string,
  revision: number,
  blobs: ContextPackageBlob[],
  extra: Partial<AgentRunEnvelopeV3> = {},
): AgentRunEnvelopeV3 {
  return envelopeV3(runId, revision, {
    context: { steps: blobs.map((blob, step) => stepFor(step, blob)) },
    ...extra,
  });
}

const rejects = (promise: () => Promise<unknown>) => Promise.resolve().then(promise);

export function agentRunStoreV3Contracts(
  name: string,
  make: () => Promise<AgentRunStoreV3Harness>,
): void {
  const withHarness =
    (fn: (harness: AgentRunStoreV3Harness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await fn(harness);
      } finally {
        await harness.cleanup?.();
      }
    };

  describe(name, () => {
    it(
      'is a V3 store and round-trips envelopes as copies',
      withHarness(async ({ store }) => {
        expect(store.checkpointVersion).toBe(3);
        expect(() => assertAgentRunStoreV3(store)).not.toThrow();
        expect(await store.load('missing')).toBeUndefined();
        const first = envelopeV3('run', 1, { workingMemory: createWorkingMemoryFixture() });
        await store.save(first);
        first.modelSteps = 99;
        first.workingMemory!.tasks!.activeTaskId = 't1';
        const loaded = await store.load('run');
        expect(loaded).toEqual(
          envelopeV3('run', 1, { workingMemory: createWorkingMemoryFixture() }),
        );
        // The task list and its active task survive as the run saved them.
        expect(loaded?.workingMemory?.tasks).toMatchObject({ activeTaskId: 't2', listRevision: 2 });
        loaded!.messages.length = 0;
        expect((await store.load('run'))?.messages).toHaveLength(1);
        await store.save(envelopeV3('run', 2, { phase: 'terminal', modelSteps: 3 }));
        expect(await store.load('run')).toMatchObject({
          version: 3,
          revision: 2,
          phase: 'terminal',
        });
      }),
    );

    it(
      'saves only at the stored revision plus one, and writes nothing otherwise',
      withHarness(async ({ store }) => {
        await expect(rejects(() => store.save(envelopeV3('fresh', 2)))).rejects.toBeInstanceOf(
          RevisionConflictError,
        );
        expect(await store.load('fresh')).toBeUndefined();
        await store.save(envelopeV3('run', 1));
        await store.save(envelopeV3('run', 2, { modelSteps: 1 }));
        // A zombie executor still believes revision 1 is current.
        for (const revision of [2, 1, 4]) {
          const error = await rejects(() =>
            store.save(envelopeV3('run', revision, { modelSteps: 7 })),
          ).then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error, `revision ${revision}`).toBeInstanceOf(RevisionConflictError);
          expect(error).toMatchObject({ subsystem: 'run', key: 'run', actualRevision: 2 });
        }
        expect(await store.load('run')).toMatchObject({ revision: 2, modelSteps: 1 });
      }),
    );

    it(
      'never takes a version 1 or 2 envelope, so a V3 run is never written back as one',
      withHarness(async ({ store }) => {
        await store.save(envelopeV3('run', 1));
        for (const version of [1, 2]) {
          const downgraded = { ...envelopeV3('run', 2), version } as unknown as AgentRunEnvelopeV3;
          await expect(rejects(() => store.save(downgraded))).rejects.toThrow(TypeError);
          await expect(rejects(() => store.save(downgraded))).rejects.toThrow(/version 3/);
        }
        const nameless = { ...envelopeV3('x', 1), runId: '' };
        await expect(rejects(() => store.save(nameless))).rejects.toThrow(TypeError);
        expect(await store.load('run')).toMatchObject({ version: 3, revision: 1 });
        expect(await store.load('')).toBeUndefined();
      }),
    );

    it(
      'lists its runs newest save first, with filters, summaries and a cursor',
      withHarness(async ({ store, advance, now }) => {
        expect(await store.list()).toEqual({ runs: [] });
        await store.save(envelopeV3('a', 1));
        await advance(20);
        await store.save(envelopeV3('b', 1, { phase: 'finalizing', scope: 'other' }));
        await advance(20);
        const cut = await now();
        await advance(20);
        await store.save(
          envelopeV3('c', 1, { phase: 'terminal', result: outcomeV3('c', 'completed') }),
        );
        await advance(20);
        await store.save(envelopeV3('s', 1, { result: outcomeV3('s', 'suspended') }));
        await advance(20);
        await store.save(envelopeV3('a', 2, { modelSteps: 3 }));

        const all = await store.list();
        expect(all.runs.map((run) => run.runId)).toEqual(['a', 's', 'c', 'b']);
        expect(all.cursor).toBeUndefined();
        expect(all.runs[0]).toMatchObject({
          runId: 'a',
          scope: 'tenant',
          phase: 'running',
          revision: 2,
        });
        expect(all.runs[0]).not.toHaveProperty('status');
        expect(all.runs[1]).toMatchObject({ runId: 's', phase: 'running', status: 'suspended' });
        expect(all.runs[2]).toMatchObject({ runId: 'c', phase: 'terminal', status: 'completed' });
        for (const run of all.runs) expect(typeof run.updatedAt).toBe('number');

        expect((await store.list({ scope: 'other' })).runs.map((run) => run.runId)).toEqual(['b']);
        expect(
          (await store.list({ phases: ['terminal', 'finalizing'] })).runs.map((run) => run.runId),
        ).toEqual(['c', 'b']);
        expect(await store.list({ phases: [] })).toEqual({ runs: [] });
        expect((await store.list({ updatedBefore: cut })).runs.map((run) => run.runId)).toEqual([
          'b',
        ]);

        const pages: string[][] = [];
        let cursor: string | undefined;
        do {
          const page = await store.list({ limit: 3, ...(cursor ? { cursor } : {}) });
          pages.push(page.runs.map((run) => run.runId));
          cursor = page.cursor;
        } while (cursor);
        expect(pages).toEqual([['a', 's', 'c'], ['b']]);
        await expect(rejects(() => store.list({ limit: 0 }))).rejects.toThrow(TypeError);
        await expect(rejects(() => store.list({ cursor: 'nope' }))).rejects.toThrow(TypeError);
      }),
    );

    it(
      'stores a context package once by digest and checks the content against it',
      withHarness(async ({ store }) => {
        const blob = await contextPackageBlob(contextPackage(0));
        expect(await store.getBlob(blob.digest)).toEqual({ status: 'missing' });
        await store.putBlob(blob);
        await store.putBlob(blob);
        expect(await store.getBlob(blob.digest)).toEqual({
          status: 'found',
          content: blob.content,
        });
        const other = await contextPackageBlob(contextPackage(0, 'other'));
        await expect(
          rejects(() => store.putBlob({ ...other, content: blob.content })),
        ).rejects.toThrow(TypeError);
        expect(await store.getBlob(other.digest)).toEqual({ status: 'missing' });
        await expect(
          rejects(() => store.putBlob({ ...other, digest: 'sha256:short' as never })),
        ).rejects.toThrow(TypeError);
      }),
    );

    it(
      'redacts every blob holding a forgotten revision and marks the manifests pointing to it',
      withHarness(async ({ store }) => {
        // `held` places mem-a at revision 2; `kept` places mem-a at revision 5.
        const held = await contextPackageBlob(contextPackage(0, 'held', 2));
        const kept = await contextPackageBlob(contextPackage(1, 'kept', 5));
        await store.putBlob(held);
        await store.putBlob(kept);
        await store.save(withBlobs('run', 1, [held, kept]));
        const event = {
          scope: { userId: 'u' },
          recordId: 'mem-a',
          revisions: [1, 2],
          operationId: 'f1',
        };
        expect(await store.redactForgotten(event)).toBe(1);
        expect(await store.getBlob(held.digest)).toEqual({ status: 'redacted' });
        expect(await store.getBlob(kept.digest)).toEqual({
          status: 'found',
          content: kept.content,
        });
        // Again: nothing more to redact.
        expect(await store.redactForgotten(event)).toBe(0);
        const loaded = await store.load('run');
        expect(loaded?.revision).toBe(1);
        expect(loaded?.context?.steps[0]?.manifest.redacted).toBe(true);
        expect(loaded?.context?.steps[1]?.manifest).not.toHaveProperty('redacted');
        // Putting the same content again never brings it back.
        await store.putBlob(held);
        expect(await store.getBlob(held.digest)).toEqual({ status: 'redacted' });
        // The executor's next save keeps working on the marked envelope.
        await store.save({ ...loaded!, revision: 2 });
        expect(await store.load('run')).toMatchObject({ revision: 2 });
        await expect(
          rejects(() => store.redactForgotten({ ...event, recordId: '' })),
        ).rejects.toThrow(TypeError);
      }),
    );

    it(
      'redacts a blob put after the forget, and a record placed without a revision',
      withHarness(async ({ store }) => {
        expect(
          await store.redactForgotten({
            scope: {},
            recordId: 'mem-b',
            revisions: [1],
            operationId: 'f',
          }),
        ).toBe(0);
        // A compile that read mem-b@1 before the forget writes its package after it.
        const late = await contextPackageBlob(contextPackage(0, 'late'));
        await store.putBlob(late);
        expect(await store.getBlob(late.digest)).toEqual({ status: 'redacted' });
        const sameIdNewRevision = await withDigest('"other"', [{ recordId: 'mem-b', revision: 2 }]);
        await store.putBlob(sameIdNewRevision);
        expect((await store.getBlob(sameIdNewRevision.digest)).status).toBe('found');
        const noRevision = await withDigest('"rag"', [{ recordId: 'mem-c' }]);
        await store.putBlob(noRevision);
        expect(
          await store.redactForgotten({
            scope: {},
            recordId: 'mem-c',
            revisions: [7],
            operationId: 'g',
          }),
        ).toBe(1);
        expect(await store.getBlob(noRevision.digest)).toEqual({ status: 'redacted' });
      }),
    );

    it(
      'prunes old terminal runs and the blobs only they used',
      withHarness(async ({ store, advance, now }) => {
        const shared = await contextPackageBlob(contextPackage(0, 'shared'));
        const own = await contextPackageBlob(contextPackage(0, 'own'));
        const orphan = await contextPackageBlob(contextPackage(0, 'orphan'));
        for (const blob of [shared, own, orphan]) await store.putBlob(blob);
        await store.save(withBlobs('done', 1, [shared, own], { phase: 'terminal' }));
        await store.save(withBlobs('running', 1, [shared]));
        await store.save(envelopeV3('finalizing', 1, { phase: 'finalizing' }));
        await store.save(
          envelopeV3('suspended', 1, { result: outcomeV3('suspended', 'suspended') }),
        );
        await advance(30);
        const cut = await now();
        await advance(30);
        await store.save(envelopeV3('recent', 1, { phase: 'terminal' }));

        expect(await store.prune({ terminalBefore: cut })).toBe(1);
        expect(await store.load('done')).toBeUndefined();
        for (const runId of ['running', 'finalizing', 'suspended', 'recent'])
          expect(await store.load(runId), runId).toBeDefined();
        expect(await store.getBlob(own.digest)).toEqual({ status: 'missing' });
        expect((await store.getBlob(shared.digest)).status).toBe('found');
        // A blob no run pointed to is not the prune's to delete.
        expect((await store.getBlob(orphan.digest)).status).toBe('found');
        expect(await store.prune({ terminalBefore: cut })).toBe(0);
        // A pruned run's ID is free again, from revision 1.
        await store.save(envelopeV3('done', 1));
        expect(await store.load('done')).toMatchObject({ revision: 1, phase: 'running' });
        expect((await store.list()).runs.map((run) => run.runId)).not.toContain('missing');
        await expect(rejects(() => store.prune({ terminalBefore: Number.NaN }))).rejects.toThrow(
          TypeError,
        );
        await expect(rejects(() => store.prune(undefined as never))).rejects.toThrow(TypeError);
      }),
    );
  });
}

/** A blob of `content` with its real digest. */
async function withDigest(
  content: string,
  records: ContextPackageBlob['records'],
): Promise<ContextPackageBlob> {
  return { digest: await sha256Digest(content), content, bytes: content.length, records };
}
