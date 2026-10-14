/**
 * Lane L3a's 2.4 acceptance scenarios (new.txt §5.1, area `context`).
 *
 * restart-same-context (spec §2.3 "Kaynak ve devam etme kuralları", §4.4): a
 * V3 run whose steps point to content-addressed context packages is reopened
 * after a process restart and reads back the identical packages (an
 * unchanged package was written once), with its working memory and active
 * task. After a `forget`, the packages holding the forgotten revisions are
 * reported redacted (their manifests marked), the documented exception that
 * makes the step compile again; the other packages still read back intact.
 */
import { expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextPackageBlob, readContextPackage } from '../../src/agent-run-v3-context';
import { createWorkingMemory } from '../../src/context/working-memory';
import { canonicalJson } from '../../src/internal/digest';
import { createSqliteAgentRunStoreV3 } from '../../src/node/runs-v3-sqlite';
import type { SqliteDatabaseLike } from '../../src/node/store-sqlite';
import type { AgentRunStoreV3 } from '../../src/types/agent-run-v3';
import { contextPackage, envelopeV3 } from '../fixtures/agent-run-v3';
import { SLOW_TEST_TIMEOUT_MS } from '../fixtures/timeouts';
import { scenario } from './registry';

/** Reads every step's package back from `store`. */
async function packagesOf(store: AgentRunStoreV3, runId: string) {
  const envelope = await store.load(runId);
  expect(envelope).toBeDefined();
  return Promise.all(envelope!.context!.steps.map((step) => readContextPackage(store, step)));
}

scenario(
  'context',
  'restart-same-context',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deuz-l3a-restart-'));
    const path = join(dir, 'runs.db');
    try {
      // Steps 0 and 1 compiled the same package; step 2 another one.
      const unchanged = contextPackage(0, 'unchanged', 2);
      const changed = contextPackage(2, 'changed', 5);
      const [first, second] = await Promise.all([
        contextPackageBlob(unchanged),
        contextPackageBlob(changed),
      ]);
      const step = (index: number, blob: typeof first, manifest = unchanged.manifest) => ({
        step: index,
        manifest: { ...manifest, step: index, blob: { digest: blob.digest, bytes: blob.bytes } },
        blob: { digest: blob.digest, bytes: blob.bytes },
      });
      const workingMemory = createWorkingMemory({
        scope: 'tenant',
        goal: 'Ship 2.4',
        tasks: {
          list: {
            goal: 'Ship 2.4',
            tasks: [
              { id: 't1', title: 'Build', status: 'done' },
              { id: 't2', title: 'Publish', status: 'in_progress' },
            ],
          },
          activeTaskId: 't2',
        },
        now: 1_000,
      });
      const saved = envelopeV3('run-restart', 3, {
        modelSteps: 3,
        context: {
          compiler: {
            version: 1,
            passes: 2,
            lastRefreshStep: 2,
            activeTaskId: 't2',
            placed: [],
            lastPackage: { digest: second.digest, bytes: second.bytes },
          },
          steps: [step(0, first), step(1, first), step(2, second, changed.manifest)],
        },
        workingMemory,
      });

      // The executor writes each step's package before its model call, then
      // checkpoints; the process dies right after.
      const before = createSqliteAgentRunStoreV3({ path });
      for (const blob of [first, first, second]) await before.putBlob(blob);
      await before.save({ ...saved, revision: 1 });
      await before.save({ ...saved, revision: 2 });
      await before.save(saved);
      await before.close();

      // A new process reopens the run: the same context, byte for byte.
      const after = createSqliteAgentRunStoreV3({ path });
      const reloaded = await after.load('run-restart');
      expect(reloaded).toEqual(saved);
      expect(reloaded?.workingMemory?.tasks).toMatchObject({ activeTaskId: 't2', listRevision: 1 });
      const read = await packagesOf(after, 'run-restart');
      const expected = [unchanged, unchanged, changed];
      read.forEach((pkg, index) => {
        expect(pkg.status).toBe('found');
        if (pkg.status !== 'found') return;
        expect(canonicalJson(pkg.package.blocks)).toBe(canonicalJson(expected[index]!.blocks));
        expect(pkg.package.manifest).toEqual(saved.context!.steps[index]!.manifest);
      });

      // A forget of mem-a's revisions 1 and 2 reaches the run store.
      expect(
        await after.redactForgotten({
          scope: { userId: 'u-1' },
          recordId: 'mem-a',
          revisions: [1, 2],
          operationId: 'forget-1',
        }),
      ).toBe(1);
      await after.close();

      // After another restart the redacted steps say so, and nothing else changed.
      const later = createSqliteAgentRunStoreV3({ path });
      const statuses = (await packagesOf(later, 'run-restart')).map((pkg) => pkg.status);
      expect(statuses).toEqual(['redacted', 'redacted', 'found']);
      const marked = await later.load('run-restart');
      expect(marked?.revision).toBe(3);
      expect(marked?.context?.steps.map((entry) => entry.manifest.redacted ?? false)).toEqual([
        true,
        true,
        false,
      ]);
      // The executor that recompiles the redacted step checkpoints as usual.
      await later.save({ ...marked!, revision: 4 });
      await later.close();

      // The unchanged package was stored once.
      const { DatabaseSync } = (await import('node:sqlite' as string)) as {
        DatabaseSync: new (file: string) => SqliteDatabaseLike;
      };
      const db = new DatabaseSync(path);
      try {
        const count = db.prepare('SELECT COUNT(*) AS n FROM deuz_runs_v3_blobs').get() as {
          n: number;
        };
        expect(Number(count.n)).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  },
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);
