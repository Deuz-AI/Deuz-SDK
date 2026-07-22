import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRunStore, pollStaleRuns } from '../src/node/runtime';
import type { RunRecord } from '../src/types/runtime';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deuz-runs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (over: Partial<RunRecord>): RunRecord => ({
  runId: 'r',
  status: 'running',
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

describe('createFileRunStore', () => {
  it('creates, reads, updates, lists, and deletes runs on disk', async () => {
    const store = createFileRunStore({ dir });
    await store.create(rec({ runId: 'a', goal: 'goal a' }));
    await store.create(rec({ runId: 'b', status: 'suspended' }));

    expect((await store.get('a'))!.goal).toBe('goal a');
    await store.update('a', { status: 'completed', stepIndex: 4 });
    expect(await store.get('a')).toMatchObject({
      status: 'completed',
      stepIndex: 4,
      goal: 'goal a',
    });

    const ids = (await store.list()).map((r) => r.runId).sort();
    expect(ids).toEqual(['a', 'b']);
    expect((await store.list({ status: 'suspended' })).map((r) => r.runId)).toEqual(['b']);

    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });

  it('survives an id with filesystem-hostile characters', async () => {
    const store = createFileRunStore({ dir });
    const runId = 'chat/issue:42 space';
    await store.create(rec({ runId }));
    expect((await store.get(runId))!.runId).toBe(runId);
  });
});

describe('pollStaleRuns', () => {
  it('returns only continuable runs older than staleMs', async () => {
    const store = createFileRunStore({ dir });
    await store.create(rec({ runId: 'fresh', status: 'running', updatedAt: 9_000 }));
    await store.create(rec({ runId: 'stale', status: 'suspended', updatedAt: 1_000 }));
    await store.create(rec({ runId: 'done', status: 'completed', updatedAt: 1_000 }));

    const stale = await pollStaleRuns(store, { staleMs: 5_000, now: () => 10_000 });
    expect(stale.map((r) => r.runId)).toEqual(['stale']); // fresh too recent; done not continuable
  });
});
