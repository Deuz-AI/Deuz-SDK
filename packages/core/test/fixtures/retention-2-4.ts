/**
 * Retention checks shared by `retention-2-4.test.ts` (every backend) and the
 * lane E2 scenarios (spec §4.4): what must outlive an explicit prune.
 */
import { expect, vi } from 'vitest';
import { contextPackageBlob } from '../../src/agent-run-v3-package';
import { createMemorySession, type VersionedMemoryStore } from '../../src/memory/versioned';
import type { AgentRunStoreV3 } from '../../src/types/agent-run-v3';
import type { Clock, Logger } from '../../src/types/deps';
import { withBlobs } from './agent-run-store-v3-conformance';
import { contextPackage } from './agent-run-v3';

export interface MemoryRetentionHarness {
  store: VersionedMemoryStore;
  /** The store's clock (the session stamps with it too). */
  clock: Clock;
  advance(ms: number): Promise<void>;
  /** The store logger's `warn`. */
  warn: ReturnType<typeof vi.fn>;
}

/** A logger whose `warn` is `warn`. */
export function loggerWith(warn: ReturnType<typeof vi.fn>): Logger {
  return { debug: () => {}, info: () => {}, warn, error: () => {} } as unknown as Logger;
}

/**
 * Versioned memory (spec §4.4): `pruneHistory({ olderThan })` deletes only
 * the past revisions of retracted or expired records, recorded strictly
 * before the cutoff; receipts stay content-free and keep deduplicating;
 * `pruneOperations` warns and drops receipts, yet a forgotten id stays
 * forgotten; time alone deletes nothing.
 */
export async function checkMemoryRetention(harness: MemoryRetentionHarness): Promise<void> {
  const { store, clock, advance, warn } = harness;
  const scope = { userId: 'u-1' };
  const session = createMemorySession({ store, scope, deps: { clock } });
  // gone: revision 1 at t0, 2 at t0+1000, retracted (3) at t0+2000.
  const t0 = clock.now();
  const created = await session.remember(
    { text: 'The old office is on Elm Street.' },
    { operationId: 'op-1' },
  );
  const id = created.records[0]!.id;
  await advance(1_000);
  await session.revise(
    id,
    { text: 'The old office is on Oak Street.' },
    { expectedRevision: 1, operationId: 'op-2' },
  );
  await advance(1_000);
  await session.retract(id, { expectedRevision: 2, operationId: 'op-3' });
  const kept = (await session.remember({ text: 'Standups are at nine.' }, { operationId: 'op-k' }))
    .records[0]!;

  // Nothing is deleted without a call: time alone changes nothing.
  await advance(30 * 86_400_000);
  expect((await store.history(scope, id)).map((record) => record.revision)).toEqual([1, 2, 3]);

  // Exclusive: revision 2, recorded exactly at the cutoff, stays.
  expect(await store.pruneHistory({ olderThan: t0 + 1_000 })).toBe(1);
  expect((await store.history(scope, id)).map((record) => record.revision)).toEqual([2, 3]);
  expect(await store.pruneHistory({ olderThan: clock.now() })).toBe(1);
  expect((await store.history(scope, id)).map((record) => record.revision)).toEqual([3]);
  // The live record keeps its history; the receipts stay, without content.
  expect(await store.history(scope, kept.id)).toHaveLength(1);
  for (const operationId of ['op-1', 'op-2', 'op-3', 'op-k']) {
    const receipt = await store.receipt(operationId);
    expect(receipt, operationId).toBeDefined();
    expect(JSON.stringify(receipt)).not.toMatch(/Street|Standups/);
  }
  // A redelivered operation is still recognized: nothing is applied twice.
  const revision = await store.scopeRevision(scope);
  const replay = await session.remember(
    { text: 'The old office is on Elm Street.' },
    { operationId: 'op-1' },
  );
  expect(replay.replayed).toBe(true);
  expect(await store.scopeRevision(scope)).toBe(revision);

  // Forget, then drop every receipt: the id stays forgotten.
  await session.forget(kept.id, { operationId: 'op-f' });
  const cutoff = clock.now() + 1;
  expect(await store.pruneOperations({ olderThan: cutoff })).toBe(5);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]![0]).toMatch(
    /^Versioned memory: pruned 5 operation receipt\(s\)\. Their operation ids no longer deduplicate/,
  );
  expect(warn.mock.calls[0]![1]).toEqual({ count: 5, olderThan: cutoff });
  expect(await store.receipt('op-f')).toBeUndefined();
  expect(await store.get(scope, kept.id, { includeRetracted: true })).toBeUndefined();
  expect(await store.forget(scope, kept.id, 'op-f2')).toMatchObject({
    revisions: [],
    alreadyForgotten: true,
  });
}

/**
 * V3 runs (spec §4.4): a forget outlives the prune of every run that held
 * the record. `cutoff` is a time past the run's last save on the store clock.
 */
export async function checkForgetOutlivesPrune(
  store: AgentRunStoreV3,
  cutoff: () => number | Promise<number>,
): Promise<void> {
  const held = await contextPackageBlob(contextPackage(0, 'held', 7));
  await store.putBlob(held);
  await store.save(withBlobs('run', 1, [held], { phase: 'terminal' }));
  await store.redactForgotten({ scope: {}, recordId: 'mem-a', revisions: [7], operationId: 'f' });
  expect(await store.prune({ terminalBefore: await cutoff() })).toBe(1);
  expect(await store.getBlob(held.digest)).toEqual({ status: 'missing' });
  // A compile that read the record before the forget writes its package
  // after the prune: still stored redacted.
  await store.putBlob(held);
  expect(await store.getBlob(held.digest)).toEqual({ status: 'redacted' });
}
