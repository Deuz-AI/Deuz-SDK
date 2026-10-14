/**
 * The in-memory V3 run store (2.4), beside `createInMemoryAgentRunStore`:
 * published from `@deuz-sdk/core/agent` by the integrator. The contract is in
 * `types/agent-run-v3.ts`. Edge-safe.
 */
import {
  agentRunV3BlobDigests,
  assertEnvelopeRevisionV3,
  assertPruneOptions,
  decodeAgentRunEnvelopeV3,
  encodeAgentRunEnvelopeV3,
  summarizeAgentRunEnvelopeV3,
} from './agent-run-v3';
import {
  assertBlobInput,
  assertForgetEvent,
  forgetTombstones,
  isForgotten,
  markRedactedSteps,
  type ContextBlobRecord,
} from './agent-run-v3-context';
import {
  agentRunListPage,
  compareAgentRunSummaries,
  isAfterAgentRunCursor,
  planAgentRunList,
} from './internal/agent-run-list';
import type { Sha256Digest } from './internal/digest';
import { resolveDependencies } from './internal/resolve-deps';
import type { AgentRunSummary } from './types/agent-run';
import type { AgentRunStoreV3 } from './types/agent-run-v3';
import type { Dependencies } from './types/deps';

interface StoredRun {
  /** The encoded envelope: what a durable store keeps, so copies go in and out. */
  payload: string;
  summary: AgentRunSummary;
  /** Every package blob the run has pointed to. */
  blobs: readonly Sha256Digest[];
}

interface StoredBlob {
  /** Undefined once redacted. */
  content: string | undefined;
  records: ContextBlobRecord[];
}

/**
 * The in-memory `AgentRunStoreV3` (2.4): a valid V3 store for tests and one
 * process. Copies in and out, saves at the stored revision plus one, blobs
 * deduplicated by digest and redacted on `redactForgotten`. Runs are listed
 * and pruned by the time of their last save on `deps.clock` (default: the
 * host clock).
 */
export function createInMemoryAgentRunStoreV3(
  options: { deps?: Dependencies } = {},
): AgentRunStoreV3 {
  const clock = resolveDependencies(options.deps).clock;
  const runs = new Map<string, StoredRun>();
  const blobs = new Map<Sha256Digest, StoredBlob>();
  /** What forgets redacted, ids only: a package put after its forget is stored redacted. */
  const tombstones: ContextBlobRecord[] = [];
  const forgotten = (records: readonly ContextBlobRecord[], among = tombstones) =>
    records.some((record) => among.some((tombstone) => isForgotten(record, tombstone)));

  return {
    checkpointVersion: 3,
    async load(runId) {
      const stored = runs.get(runId);
      if (!stored) return undefined;
      const redacted = new Set(
        stored.blobs.filter((digest) => {
          const blob = blobs.get(digest);
          return blob !== undefined && blob.content === undefined;
        }),
      );
      return markRedactedSteps(decodeAgentRunEnvelopeV3(stored.payload), redacted);
    },
    async save(envelope) {
      const payload = encodeAgentRunEnvelopeV3(envelope);
      const stored = runs.get(envelope.runId);
      assertEnvelopeRevisionV3(stored && { revision: stored.summary.revision }, envelope);
      runs.set(envelope.runId, {
        payload,
        summary: summarizeAgentRunEnvelopeV3(envelope, clock.now()),
        // Every blob the run ever pointed to, as the SQL stores' refs keep them.
        blobs: [...new Set([...(stored?.blobs ?? []), ...agentRunV3BlobDigests(envelope)])],
      });
    },
    async list(query) {
      const plan = planAgentRunList(query);
      const rows = [...runs.values()]
        .map((run) => run.summary)
        .filter(
          (run) =>
            (plan.phases === undefined || plan.phases.includes(run.phase)) &&
            (plan.updatedBefore === undefined || run.updatedAt < plan.updatedBefore) &&
            (plan.scope === undefined || run.scope === plan.scope) &&
            isAfterAgentRunCursor(run, plan.after),
        )
        .sort(compareAgentRunSummaries);
      return agentRunListPage(rows.slice(0, plan.limit + 1), plan.limit);
    },
    async putBlob(blob) {
      await assertBlobInput(blob);
      const stored = blobs.get(blob.digest) ?? { content: blob.content, records: [] };
      for (const record of blob.records)
        if (
          !stored.records.some(
            (known) => known.recordId === record.recordId && known.revision === record.revision,
          )
        )
          stored.records.push(
            record.revision === undefined
              ? { recordId: record.recordId }
              : { recordId: record.recordId, revision: record.revision },
          );
      if (forgotten(stored.records)) stored.content = undefined;
      blobs.set(blob.digest, stored);
    },
    async getBlob(digest) {
      const stored = blobs.get(digest);
      if (!stored) return { status: 'missing' };
      return stored.content === undefined
        ? { status: 'redacted' }
        : { status: 'found', content: stored.content };
    },
    async redactForgotten(event) {
      assertForgetEvent(event);
      const added = forgetTombstones(event);
      for (const tombstone of added)
        if (
          !tombstones.some(
            (known) =>
              known.recordId === tombstone.recordId && known.revision === tombstone.revision,
          )
        )
          tombstones.push(tombstone);
      let redacted = 0;
      for (const stored of blobs.values())
        if (stored.content !== undefined && forgotten(stored.records, added)) {
          stored.content = undefined;
          redacted++;
        }
      return redacted;
    },
    async prune(options) {
      const terminalBefore = assertPruneOptions(options);
      const pruned = [...runs.entries()].filter(
        ([, run]) => run.summary.phase === 'terminal' && run.summary.updatedAt < terminalBefore,
      );
      for (const [runId] of pruned) runs.delete(runId);
      const kept = new Set([...runs.values()].flatMap((run) => run.blobs));
      for (const [, run] of pruned)
        for (const digest of run.blobs) if (!kept.has(digest)) blobs.delete(digest);
      return pruned.length;
    },
  };
}
