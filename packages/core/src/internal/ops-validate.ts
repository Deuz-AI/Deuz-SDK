/**
 * Validation shared by the lease providers and native run stores (2.2): the
 * in-memory ones in `ops.ts` and `agent-run.ts`, and the SQLite and Postgres
 * ones under `node/`. Internal, so no entry point publishes these helpers.
 */
import type { AgentRunEnvelope } from '../types/agent-run';

/** Shared request validation for every lease provider. */
export function assertLeaseRequest(key: string, owner: string, ttlMs: number): void {
  if (typeof key !== 'string' || !key) throw new TypeError('Lease key must be a nonempty string');
  if (typeof owner !== 'string' || !owner)
    throw new TypeError('Lease owner must be a nonempty string');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
    throw new TypeError('Lease ttlMs must be a positive integer');
}

/**
 * The native run store fence (2.2): a save must carry the stored revision plus
 * one. A stored 2.1 envelope without a revision counts as 0, and a
 * revision-less save is accepted only while the stored run is still unfenced.
 */
export function assertEnvelopeRevision(
  stored: Pick<AgentRunEnvelope, 'revision'> | undefined,
  next: Pick<AgentRunEnvelope, 'revision' | 'runId'>,
): void {
  const current = stored?.revision ?? 0;
  if (next.revision === undefined ? current === 0 : next.revision === current + 1) return;
  throw new Error(
    `Agent run revision conflict for ${next.runId}: expected ${current + 1}, got ${String(next.revision)}`,
  );
}
